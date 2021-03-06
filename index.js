require('dotenv').config();
require('firebase/firestore');

const querystring = require('querystring');
const express = require('express');
const bodyParser = require('body-parser');
const firebase = require('firebase');
const fetch = require('node-fetch');
const schedule = require('node-schedule');

const ProcessingQueue = require('./ProcessingQueue.js');


/*  CONFIG  */

const routes = {
  root: '/',
  oAuth: '/oauth',
  events: '/events',
};

const collections = {
  integrations: 'integrations',
  config: 'config',
};


/*  INITIALIZATION  */

const initializeDb = () => {
  firebase.initializeApp({
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN,
    databaseURL: process.env.FIREBASE_DATABASE_URL,
    projectId: process.env.FIREBASE_PROJECT_ID,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  });

  return firebase.firestore();
};

const initializeApp = () => {
  const app = express();

  app.use(bodyParser.urlencoded({ extended: true }));
  app.use(bodyParser.json());

  app.listen(process.env.PORT, () => {
    console.log(`Listening on port ${process.env.PORT}. Hurray!`);
  });

  return app;
};

const db = initializeDb();
const app = initializeApp();


/*  UTILS  */

const getRouteUrl = (route) => `${process.env.BASE_URL}${routes[route]}`;

const makeUrl = (url, params) => {
  if (!params) {
    return url;
  }

  const stringifiedParams = querystring.stringify(params);

  return `${url}?${stringifiedParams}`;
};

const isSadMessage = originalMessage => {
  const message = originalMessage.toLowerCase();

  return (
    message.includes(':(')
      || message.includes('sad')
  );
}


/*  API  */

const authorize = () => {
  const params = {
    client_id: process.env.SLACK_CLIENT_ID,
    scope: 'chat:write:bot,channels:history',
    redirect_uri: getRouteUrl('oAuth'),
  };

  return fetch(makeUrl('https://slack.com/oauth/authorize', params));
};

const getAccessToken = (code) => {
  const params = {
    client_id: process.env.SLACK_CLIENT_ID,
    client_secret: process.env.SLACK_CLIENT_SECRET,
    code,
    redirect_uri: getRouteUrl('oAuth'),
  };

  return fetch(makeUrl('https://slack.com/api/oauth.access', params));
};

const findAnimalPic = () => {
  const params = {
    query: 'animals',
    orientation: 'squarish',
    w: 400,
    h: 500,
  };
  const url = makeUrl('https://api.unsplash.com/photos/random', params);

  return fetch(url, {
    headers: {
      'Accept-Version': 'v1',
      Authorization: `Client-ID ${process.env.UNSPLASH_APP_ID}`,
    },
  })
    .then(response => response.json())
    .then(data => ({
      url: data.urls.custom,
      htmlUrl: data.links.html,
      author: data.user.name,
    }));
};

const postMessage = (url, { url: picUrl, htmlUrl, author }) => {
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-type': 'application/json',
    },
    body: JSON.stringify({
      attachments: [{
        pretext: 'Smile! :) It\'s going to be a good day',
        image_url: picUrl,
        footer: `By <${htmlUrl}|${author}> from <unsplash.com|Unsplash>`,
      }],
    }),
  });
}

const postResponseToSadMessage = (url, userId) => {
  return findAnimalPic()
    .then(({ url: picUrl, htmlUrl, author }) => {
      return fetch(url, {
        method: 'POST',
        headers: {
          'Content-type': 'application/json',
        },
        body: JSON.stringify({
          attachments: [{
            pretext: `I'm really sorry to see you sad, <@${userId}>. Here, have this pic of a cute animal`,
            image_url: picUrl,
            footer: `By <${htmlUrl}|${author}> from <unsplash.com|Unsplash>`,
          }],
        }),
      });
    });
};

const sendAnimalPics = () => {
  const getPic = findAnimalPic();
  const getCollections = db
        .collection(collections.integrations)
        .get()
        .then(colls => colls.docs.map(coll => coll.get('incoming_webhook').url));

  Promise.all([getPic, getCollections])
    .then(([picData, webhookUrls]) => {
      webhookUrls.forEach(webhookUrl => {
        postMessage(webhookUrl, picData);
      });
    });
}


/*  MESSAGE QUEUE HANDLING  */

const messageQueue = new ProcessingQueue(data => {
  const {
    team_id: teamId,
    event: { text, user },
  } = data;

  if (isSadMessage(text)) {
    db
      .collection(collections.integrations)
      .doc(teamId)
      .get()
      .then(coll => {
        postResponseToSadMessage(coll.get('incoming_webhook').url, user);
      });
  }
});


/*  ROUTES  */

app.get(routes.root, (req, res) => {
  res.send(
    `<h1>Hello world</h1>`,
  );
});

app.get(routes.oAuth, (req, res) => {
  if (req.query.error) {
    res.status(500);
    res.send(
      'The oAuth request did not contain the required code.',
    );
    console.log('The oAuth request did not contain the required code.');

    return;
  }

  getAccessToken(req.query.code)
    .then((response) => {
      if (!response.ok) {
        console.log('Error getting oAuth response');
        throw new Error(response.error);
        return;
      }

      return response.json();
    })
    .then((data) => {
      db
        .collection(collections.integrations)
        .doc(data.team_id)
        .set(data);

      return data.incoming_webhook.url;
    })
    .then(webhookUrl => {
      res.send('success');

      findAnimalPic()
        .then(picData => {
          postMessage(webhookUrl, picData);
        });
    });
});

app.post(routes.events, (req, res) => {
  if (req.body.type === 'url_verification') {
    db
      .collection(collections.config)
      .doc('eventsToken')
      .set({ token: req.body.token });
    res.status(200);
    res.send(req.body.challenge);
  }

  const getToken = db
        .collection(collections.config)
        .doc('eventsToken')
        .get();

  getToken.then(data => {
    const token = data.get('token');

    if (token !== req.body.token) {
      return;
    }

    if (req.body.type !== 'event_callback') {
      res.status(200);
      res.send();
      return;
    }

    if (
      req.body.event.type === 'message'
        && req.body.event.subtype !== 'bot_message'
    ) {
      db
        .collection(collections.integrations)
        .doc(req.body.team_id)
        .get()
        .then(data => {
          const assignedChannel = data.get('incoming_webhook').channel_id;

          if (req.body.event.channel !== assignedChannel) {
            return;
          }

          messageQueue.add(req.body);
        });

      res.status(200);
      res.send();
    }

    if (req.body.event.type === 'app_uninstalled') {
      db
        .collection(collections.integrations)
        .doc(req.body.team_id)
        .delete();

      res.status(200);
      res.send();
    }
  });
});


/*  CRON  */

schedule.scheduleJob('0 0 7 * * *', sendAnimalPics);
