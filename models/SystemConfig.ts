import mongoose, { Schema, Document } from 'mongoose';

export interface ISystemConfig extends Document {
  key: string;
  platformBalance: number; // Stored in USDT (e.g. 10240.50)
  lowFundsThreshold: number; // Stored in USDT (e.g. 15000.00)
  warmWalletAddress: string;
  usdtContractAddress: string;
  coldTreasuryAddress: string;
  createdAt: Date;
  updatedAt: Date;
}

const SystemConfigSchema: Schema = new Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      default: 'platform_config',
    },
    platformBalance: {
      type: Number,
      required: true,
      default: 10240.50, // Initial state for demonstration
    },
    lowFundsThreshold: {
      type: Number,
      required: true,
      default: 15000.00,
    },
    warmWalletAddress: {
      type: String,
      required: true,
      trim: true,
    },
    usdtContractAddress: {
      type: String,
      required: true,
      trim: true,
    },
    coldTreasuryAddress: {
      type: String,
      required: true,
      trim: true,
    },
  },
  {
    timestamps: true,
  }
);

// Pre-save to ensure the key is always 'platform_config'
SystemConfigSchema.pre('save', function (this: any) {
  this.set('key', 'platform_config');
});

export default mongoose.models.SystemConfig ||
  mongoose.model<ISystemConfig>('SystemConfig', SystemConfigSchema);
