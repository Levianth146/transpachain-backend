import mongoose, { Schema, Document } from "mongoose";

export interface IVerifiedOrg extends Document {
  address:    string;   // lowercase
  verified:   boolean;
  updatedAt:  Date;
  txHash?:    string;
  blockNumber?: number;
}

const VerifiedOrgSchema = new Schema<IVerifiedOrg>(
  {
    address:     { type: String, required: true, unique: true, lowercase: true },
    verified:    { type: Boolean, required: true, default: true },
    txHash:      { type: String },
    blockNumber: { type: Number },
  },
  { timestamps: true }
);

export const VerifiedOrg = mongoose.model<IVerifiedOrg>("VerifiedOrg", VerifiedOrgSchema);