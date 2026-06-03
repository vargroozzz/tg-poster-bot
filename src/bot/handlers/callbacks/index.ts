import { registerScheduling } from './scheduling.js';
import { registerQueue } from './queue.js';
import { registerSleep } from './sleep.js';
import { registerInterval } from './interval.js';
import { registerReply } from './reply.js';

registerScheduling();
registerQueue();
registerSleep();
registerInterval();
registerReply();
