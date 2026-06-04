import { Schema, model, Document } from "mongoose";

export type OrgProfileStatus = "draft" | "pending" | "approved" | "rejected";

export interface IOrgProfile extends Document {
  orgAddress: string;
  legalName: string;
  description: string;
  website: string;
  country: string;
  registrationDocCID: string;
  contactEmail: string;
  status: OrgProfileStatus;
  reviewerNote: string;
  submittedAt: Date;
  reviewedAt?: Date;
}

const OrgProfileSchema = new Schema<IOrgProfile>(
  {
    orgAddress: { type: String, required: true, unique: true, lowercase: true, index: true },
    legalName: { type: String, default: "" },
    description: { type: String, default: "" },
    website: { type: String, default: "" },
    country: { type: String, default: "" },
    registrationDocCID: { type: String, default: "" },
    contactEmail: { type: String, default: "" },
    status: {
      type: String,
      enum: ["draft", "pending", "approved", "rejected"],
      default: "draft",
    },
    reviewerNote: { type: String, default: "" },
    submittedAt: { type: Date, default: Date.now },
    reviewedAt: { type: Date },
  },
  { timestamps: true }
);

export const OrgProfile = model<IOrgProfile>("OrgProfile", OrgProfileSchema);
