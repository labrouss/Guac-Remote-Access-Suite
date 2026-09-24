import { Queue } from 'bullmq';

const connection = { host: process.env.REDIS_HOST, port: Number(process.env.REDIS_PORT ?? 6379) };

export const videoExportQueue = new Queue('video-export', { connection });

export async function queueVideoExport(recordingId: string) {
  await videoExportQueue.add(
    'encode',
    { recordingId },
    { attempts: 2, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: true, removeOnFail: false }
  );
}
