import { Schema, model, Document } from "mongoose";

export interface IEvidence extends Document {
  campaignId: number;
  milestoneIndex: number;
  orgAddress: string;
  title: string;
  description: string;
  imageUrl: string;
  ipfsCID: string;
  approvalStatus: "pending" | "approved" | "rejected";
  submittedAt: Date;
  reviewedAt?: Date;
  reviewerNote?: string;
}

const EvidenceSchema = new Schema<IEvidence>(
  {
    campaignId: { type: Number, required: true, index: true },
    milestoneIndex: { type: Number, required: true },
    orgAddress: { type: String, required: true, lowercase: true },
    title: { type: String, default: "" },
    description: { type: String, default: "" },
    imageUrl: { type: String, default: "" },
    ipfsCID: { type: String, default: "" },
    approvalStatus: { type: String, enum: ["pending", "approved", "rejected"], default: "pending" },
    submittedAt: { type: Date, default: Date.now },
    reviewedAt: { type: Date },
    reviewerNote: { type: String, default: "" },
  },
  { timestamps: true }
);

EvidenceSchema.index({ campaignId: 1, milestoneIndex: 1 });

export const Evidence = model<IEvidence>("Evidence", EvidenceSchema);
