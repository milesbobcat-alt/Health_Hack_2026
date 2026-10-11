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


const timingText = value => ({daily:'once a day','once daily':'once a day','twice daily':'twice a day','three times daily':'three times a day',weekly:'once a week'}[value.toLowerCase()] || value);
export function patientPlainText(text) {
  return String(text || '').trim().replace(/;\s*/g, '. ').replace(/(^|[.!?]\s+)([a-z])/g, (_, prefix, letter) => prefix + letter.toUpperCase());
}
const finishSentence = text => {
  const clean = patientPlainText(text);
  return /[.!?]$/.test(clean) ? clean : `${clean}.`;
};
function patientMedicine(item) {
  if (typeof item !== 'string') return item;
  const match = item.match(/^Name:\s*(.*?)\. Strength:\s*(.*?)\. Dose:\s*(.*?)\. Frequency:\s*(.*?)\. Instructions:\s*([\s\S]*)$/i);
  if (!match) return item;
  return Object.fromEntries(medicationFields.map((key,index)=>[key,/^Not documented\.?$/i.test(match[index+1].trim()) ? null : match[index+1].trim()]));
}
export function patientMedicationNeedsReview(item) {
  const med = patientMedicine(item);
  return /REVIEW REQUIRED|conflicting instructions/i.test(typeof med === 'string' ? med : med.instructions || '');
}
export function patientMedicationText(item) {
  item = patientMedicine(item);
  if (typeof item === 'string') return patientMedicationNeedsReview(item) ? 'Confirm this medicine’s dose and schedule with your care team.' : finishSentence(item);
  const {name,strength,dose,frequency,instructions} = item;
  if (patientMedicationNeedsReview(item)) return `${name || 'This medicine'}: Confirm the dose and schedule with your care team.`;
  if (/\b(stop taking|do not take|hold|withhold)\b/i.test(instructions || '')) return finishSentence(`${instructions.toLowerCase().includes((name || '').toLowerCase()) ? '' : `${name || 'This medicine'}: `}${instructions}`);
  if (!name) return instructions ? finishSentence(instructions) : 'Medication name not documented.';
  const counts = {'1':'one','2':'two','3':'three','4':'four'};
  const tablet = dose?.match(/^(\d+)\s+(tablets?|capsules?)$/i);
  const productStrength = strength?.replace(/\s+(per|\/)\s*(1\s+)?(tablet|capsule)$/i,'');
  let sentence;
  if (tablet && strength && /^\d+(?:\.\d+)?\s*(mg|mcg|g)$/i.test(productStrength)) {
    const unit = tablet[2].toLowerCase();
    sentence = `Take ${counts[tablet[1]] || tablet[1]} ${productStrength} ${unit} of ${name}`;
  } else if (dose) sentence = `Take ${dose} of ${name}${strength ? ` (${strength})` : ''}`;
  else {
    const detail = `${name}${strength ? ` (${strength})` : ''}. Dose not documented. ${frequency ? `Schedule: ${timingText(frequency)}.` : 'Frequency not documented.'}${!strength ? ' Strength not documented.' : ''}`;
    return instructions ? `${detail} ${finishSentence(instructions)}` : detail;
  }
  const timing = {'daily':'once a day','once daily':'once a day','twice daily':'twice a day','twice a day':'twice a day','three times daily':'three times a day','weekly':'once a week'};
  if (frequency) sentence += ` ${timing[frequency.toLowerCase()] || frequency}`;
  else sentence += '. Frequency not documented';
  sentence = finishSentence(sentence);
  if (instructions && instructions.trim().toLowerCase().replace(/[.!?]+$/,'') !== sentence.toLowerCase().replace(/[.!?]+$/,'')) sentence += ` ${finishSentence(instructions)}`;
  if (!strength) sentence += ' Strength not documented.';
  return sentence;
}
export function patientWoundCareText(item) {
  if (typeof item === 'string') return finishSentence(item);
  const text = finishSentence(item.instructions);
  if (!item.frequency) return `${text} Frequency not documented.`;
  if (item.instructions.toLowerCase().includes(item.frequency.toLowerCase())) return text;
  return `${text} Do this ${item.frequency}.`;
}
