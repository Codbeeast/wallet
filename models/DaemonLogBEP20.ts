import mongoose, { Schema, Document } from 'mongoose';

export interface IDaemonLogBEP20 extends Document {
  message: string;
  type: 'info' | 'success' | 'warn' | 'error';
  createdAt: Date;
}

const DaemonLogBEP20Schema: Schema = new Schema(
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
    timestamps: true,
  }
);

export default mongoose.models.DaemonLogBEP20 ||
  mongoose.model<IDaemonLogBEP20>('DaemonLogBEP20', DaemonLogBEP20Schema);
