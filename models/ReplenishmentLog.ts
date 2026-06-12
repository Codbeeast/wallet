import mongoose, { Schema, Document } from 'mongoose';

export interface IReplenishmentLog extends Document {
  txHash: string;
  amount: number; // Stored in Sun (1 USDT = 1,000,000 Sun)
  status: 'PENDING' | 'PROCESSING' | 'SUCCESS' | 'FAILED';
  fromAddress?: string;
  toAddress?: string;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

const ReplenishmentLogSchema: Schema = new Schema(
  {
    txHash: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    status: {
      type: String,
      required: true,
      enum: ['PENDING', 'PROCESSING', 'SUCCESS', 'FAILED'],
      default: 'PENDING',
    },
    fromAddress: {
      type: String,
      trim: true,
    },
    toAddress: {
      type: String,
      trim: true,
    },
    error: {
      type: String,
      trim: true,
    },
  },
  {
    timestamps: true,
  }
);

// Mutex Lock: Enforce at most one document in the 'PROCESSING' status.
// A partial unique index creates a unique constraint on 'status',
// but ONLY for documents where status is 'PROCESSING'.
ReplenishmentLogSchema.index(
  { status: 1 },
  {
    unique: true,
    partialFilterExpression: { status: 'PROCESSING' },
  }
);

export default mongoose.models.ReplenishmentLog ||
  mongoose.model<IReplenishmentLog>('ReplenishmentLog', ReplenishmentLogSchema);
