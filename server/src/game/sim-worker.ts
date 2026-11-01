// Runs one simulation off the main thread so the live server keeps serving players while it runs.
import { parentPort, workerData } from 'node:worker_threads';
import { runSim, type SimOptions } from './sim.ts';

const result = await runSim(workerData as SimOptions);
parentPort?.postMessage(result);
