import mongoose, { Schema, Document } from 'mongoose';

export interface IReplenishmentLogBEP20 extends Document {
  txHash: string;
  /**
   * Amount stored as a string to preserve full Wei precision (18 decimals).
   * Example: "5000000000000000000000" = 5000 USDT in Wei (18 decimals)
   */
  amount: string;
  status: 'PENDING' | 'PROCESSING' | 'SUCCESS' | 'FAILED';
  fromAddress?: string;
  toAddress?: string;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

const ReplenishmentLogBEP20Schema: Schema = new Schema(
  {
    txHash: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    amount: {
      // Stored as string to support full 18-decimal Wei precision safely
      type: String,
      required: true,
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

// Mutex Lock: At most one document with 'PROCESSING' status at any time
ReplenishmentLogBEP20Schema.index(
  { status: 1 },
  {
    unique: true,
    partialFilterExpression: { status: 'PROCESSING' },
  }
);

export default mongoose.models.ReplenishmentLogBEP20 ||
  mongoose.model<IReplenishmentLogBEP20>('ReplenishmentLogBEP20', ReplenishmentLogBEP20Schema);
