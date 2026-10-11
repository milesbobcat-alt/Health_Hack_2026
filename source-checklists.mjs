import {editMedication, editWoundCare} from "./medication-plan.mjs";
const keys = ["medicine", "woundCare", "followUps", "additional", "contactPhysician"];
const canonical = value => value?.trim().toLowerCase().replace(/\s+/g, " ");
export function mergeSourceChecklists(plans) {
 const merged = Object.fromEntries(keys.map(key => [key, []]));
 for (const {source, checklist} of plans) {
  for (const key of keys) for (const original of checklist[key]) {
   const item = key === "medicine" ? editMedication(original) : key === "woundCare" ? editWoundCare(original) : original;
   const list = merged[key];
   if (typeof item === "string") {if (!list.some(other => canonical(other) === canonical(item))) list.push(item);continue;}
   if (list.some(other => JSON.stringify(other) === JSON.stringify(item))) continue;
   const identity = key === "medicine" ? item.name : item.instructions;
   const existing = identity ? list.find(other => canonical(key === "medicine" ? other.name : other.instructions) === canonical(identity)) : null;
   if (!existing) {list.push({...item});continue;}
   const fields = key === "medicine" ? ["strength", "dose", "frequency"] : ["frequency"];
   const conflicts = [];
   for (const field of fields) {
    if (existing[field] && item[field] && canonical(existing[field]) !== canonical(item[field])) {
     conflicts.push(`${field}: earlier source says "${existing[field]}"; ${source} says "${item[field]}"`);existing[field] = null;
    } else if (!existing[field] && !/REVIEW REQUIRED/.test(existing.instructions || "")) existing[field] = item[field];
   }
   if (key === "medicine" && item.instructions && canonical(item.instructions) !== canonical(existing.instructions))
    existing.instructions = [existing.instructions, item.instructions].filter(Boolean).join("; ");
   if (conflicts.length) existing.instructions = [existing.instructions, `REVIEW REQUIRED: conflicting instructions — ${conflicts.join("; ")}`].filter(Boolean).join("; ");
  }
 }
 return merged;
}
