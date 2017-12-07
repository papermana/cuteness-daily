class ProcessingQueue {
  constructor(processingFunction) {
    this.processingFunction = processingFunction;

    this.queue = [];
    this.processing = false;
  }

  add(data) {
    this.queue.push(data);

    if (!this.processing) {
      this.processing = true;
      this.process();
    }
  }

  process() {
    const data = this.queue.shift();

    this.processingFunction(data);

    if (this.queue.length) {
      setTimeout(() => this.process(), 0);
    } else {
      this.processing = false;
    }
  }
}

module.exports = ProcessingQueue;
