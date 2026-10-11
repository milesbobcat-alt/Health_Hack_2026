export const medicationFields = ["name", "strength", "dose", "frequency", "instructions"];
export function isMedication(item) {
  return Boolean(item && typeof item === "object" && !Array.isArray(item)
    && Object.keys(item).every(key => medicationFields.includes(key))
    && medicationFields.every(key => item[key] === null || (typeof item[key] === "string" && Boolean(item[key].trim())))
    && medicationFields.some(key => typeof item[key] === "string"));
}
export function editMedication(item) {
  return typeof item === "string"
    ? {name: null, strength: null, dose: null, frequency: null, instructions: item}
    : Object.fromEntries(medicationFields.map(key => [key, item[key]?.trim() || null]));
}
export function medicationText(item) {
  if (typeof item === "string") return item;
  return medicationFields.map(key => `${key[0].toUpperCase() + key.slice(1)}: ${item[key] || "Not documented"}`).join(". ");
}

export const woundFields = ["instructions", "frequency"];
export function isWoundCare(item) {
  return Boolean(item && typeof item === "object" && !Array.isArray(item)
    && Object.keys(item).every(key => woundFields.includes(key))
    && typeof item.instructions === "string" && Boolean(item.instructions.trim())
    && (item.frequency === null || (typeof item.frequency === "string" && Boolean(item.frequency.trim()))));
}
export function editWoundCare(item) {
  return typeof item === "string" ? {instructions: item, frequency: null}
    : {instructions: item.instructions?.trim() || "", frequency: item.frequency?.trim() || null};
}
export function woundCareText(item) {
  return typeof item === "string" ? item : `${item.instructions}. Frequency: ${item.frequency || "Not documented"}`;
}
