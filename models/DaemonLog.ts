import mongoose, { Schema, Document } from 'mongoose';

export interface IDaemonLog extends Document {
  message: string;
  type: 'info' | 'success' | 'warn' | 'error';
  createdAt: Date;
}

const DaemonLogSchema: Schema = new Schema(
  {
    message: {
      type: String,
      required: true,
    },
    type: {
      type: String,
      required: true,
      enum: ['info', 'success', 'warn', 'error'],
      default: 'info',
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

// Auto-expire logs after 2 hours to keep the database clean
DaemonLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7200 });

export default mongoose.models.DaemonLog ||
  mongoose.model<IDaemonLog>('DaemonLog', DaemonLogSchema);
