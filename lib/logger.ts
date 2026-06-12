import dbConnect from './db';
import DaemonLog from '@/models/DaemonLog';

export async function logSystemEvent(
  message: string,
  type: 'info' | 'success' | 'warn' | 'error' = 'info'
) {
  try {
    await dbConnect();
    await DaemonLog.create({ message, type });
    // Also output to the terminal/stdout
    const colors = {
      info: '\x1b[36m', // cyan
      success: '\x1b[32m', // green
      warn: '\x1b[33m', // yellow
      error: '\x1b[31m', // red
      reset: '\x1b[0m',
    };
    console.log(`${colors[type] || ''}[${type.toUpperCase()}] ${message}${colors.reset}`);
  } catch (err) {
    console.error('Failed to write system log:', err);
  }
}
