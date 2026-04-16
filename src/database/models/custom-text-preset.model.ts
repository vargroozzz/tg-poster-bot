import { Schema, model, Document, Types } from 'mongoose';

export interface ICustomTextPreset extends Document {
  _id: Types.ObjectId;
  label: string;
  text: string;
  addedAt: Date;
}

const customTextPresetSchema = new Schema<ICustomTextPreset>({
  label: { type: String, required: true },
  text: { type: String, required: true },
  addedAt: { type: Date, default: Date.now },
});

export const CustomTextPreset = model<ICustomTextPreset>('CustomTextPreset', customTextPresetSchema);

export async function listCustomTextPresets(): Promise<ICustomTextPreset[]> {
  return await CustomTextPreset.find().sort({ addedAt: 1 });
}

export async function addCustomTextPreset(label: string, text: string): Promise<ICustomTextPreset> {
  return await CustomTextPreset.create({ label, text });
}

export async function removeCustomTextPreset(id: string): Promise<boolean> {
  const result = await CustomTextPreset.deleteOne({ _id: id });
  return result.deletedCount > 0;
}
