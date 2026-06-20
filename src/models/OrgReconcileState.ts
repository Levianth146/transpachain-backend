import mongoose, { Schema, Document } from "mongoose";

export interface IOrgReconcileState extends Document {
  key: string;
  lastOrgReconcileBlock: number;
  fullScanComplete: boolean;
  updatedAt: Date;
}

const OrgReconcileStateSchema = new Schema<IOrgReconcileState>(
  {
    key: { type: String, required: true, unique: true, default: "default" },
    lastOrgReconcileBlock: { type: Number, required: true, default: 0 },
    fullScanComplete: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export const OrgReconcileState = mongoose.model<IOrgReconcileState>(
  "OrgReconcileState",
  OrgReconcileStateSchema
);

export interface OrgReconcileStateRecord {
  lastOrgReconcileBlock: number;
  fullScanComplete: boolean;
}

export async function getOrgReconcileState(): Promise<OrgReconcileStateRecord | null> {
  const doc = await OrgReconcileState.findOne({ key: "default" })
    .select("lastOrgReconcileBlock fullScanComplete")
    .lean();
  if (!doc) return null;
  return {
    lastOrgReconcileBlock: doc.lastOrgReconcileBlock,
    fullScanComplete: doc.fullScanComplete,
  };
}

export async function saveOrgReconcileState(
  lastOrgReconcileBlock: number,
  fullScanComplete: boolean
): Promise<void> {
  await OrgReconcileState.findOneAndUpdate(
    { key: "default" },
    { lastOrgReconcileBlock, fullScanComplete },
    { upsert: true }
  );
}
