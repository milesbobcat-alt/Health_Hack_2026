// A conservative draft helper. It keeps source wording visible for clinical review.
export const categories = {
  medication: "Medicines",
  care: "Care",
  testing: "Tests",
  avoid: "Avoid / do not",
};

function bulletsInSection(text, heading, stopAt) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^\\s*${heading}\\s*:?\\s*$`, "i").test(line));
  if (start < 0) return [];
  const result = [];
  for (const line of lines.slice(start + 1)) {
    if (stopAt.test(line)) break;
    const bullet = line.match(/^\s*(?:[•*-]|\d+[.)])\s+(.+)/);
    if (bullet) result.push(bullet[1].trim());
    else if (line.trim() && result.length) result[result.length - 1] += ` ${line.trim()}`;
  }
  return result.map((item) => item.replace(/\s+/g, " ").trim());
}

function categoryFor(text) {
  if (/\b(avoid|do not|don't|never|refrain|no driving|no lifting|do not use|do not take)\b/i.test(text)) return "avoid";
  if (/\b(medicin\w*|medicat\w*|antibiotic\w*|dose\w*|tablet\w*|capsule\w*|inhaler\w*|prescription\w*|apixaban|insulin|metformin|lisinopril|aspirin|metoprolol|atorvastatin|amlodipine|losartan|warfarin|furosemide|prednisone|albuterol|amoxicillin|omeprazole|levothyroxine|gabapentin|oxycodone|sertraline|ondansetron|clopidogrel|[a-z]+(?:pril|sartan|statin|olol|prazole|cillin|floxacin|gliptin|gliflozin))\b/i.test(text)) return "medication";
  if (/\b(test|lab|blood work|panel|creatinine|potassium|electrolytes|glucose|blood sugar)\b/i.test(text)) return "testing";
  return "care";
}

const medicationHeadings = {
  before: /^(?:Home Medications?|Home Medication List|Current Outpatient Medications|Outpatient Medications Prior to Admission|Medications Prior to Admission|Medications Before Admission|Prior to Admission Medications|Pre[- ]Admission Medications|Prehospital Medications|Prehospital Medication List|Medication List Before Hospitalization|Medications at Home)\s*:?\s*$/i,
  after: /^(?:Discharge Medications?|Discharge Medication List|Medications at Discharge|Medications on Discharge|Medication List at Discharge|Medication Changes at Discharge)\s*:?\s*$/i,
};

function medicationList(text, heading) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => heading.test(line.trim()));
  if (start < 0) return [];
  const entries = [];
  const endHeading = /^\s*(?:Home Medications?|Home Medication List|Current Outpatient Medications|Outpatient Medications Prior to Admission|Medications Prior to Admission|Medications Before Admission|Prior to Admission Medications|Pre[- ]Admission Medications|Prehospital Medications|Prehospital Medication List|Medication List Before Hospitalization|Medications at Home|Discharge Medications?|Discharge Medication List|Medications at Discharge|Medications on Discharge|Medication List at Discharge|Medication Changes at Discharge|Discharge Instructions|Return Precautions|Warning Signs|Follow[- ]?up|Allergies|Diagnosis|Diagnoses|Hospital Course|Physical Examination|Patient Instructions|Nursing Discharge Teaching|Example\s+\d+)\b/i;
  for (const line of lines.slice(start + 1)) {
    if (endHeading.test(line)) break;
    const clean = line.trim().replace(/^(?:[•*-]|\d+[.)])\s+/, "");
    if (!clean) continue;
    if (/^[A-Z][A-Z\s/&-]{2,45}:?$/.test(clean) && !/\d/.test(clean)) break;
    if (/^(?:Name|Medication|Dose|Route|Frequency)\s*:?$/i.test(clean)) continue;
    if (/^\s*(?:[•*-]|\d+[.)])\s+/.test(line) || !entries.length) entries.push(clean);
    else entries[entries.length - 1] += ` ${clean}`;
  }
  return entries.map((entry) => entry.replace(/\s+/g, " ").trim()).filter(Boolean);
}

function frequencyFor(text) {
  if (/\b(daily|each day|each morning|every day|every morning|once daily|twice daily|nightly|four times daily)\b/i.test(text)) return "daily";
  return "once";
}

function splitFollowUp(text) {
  const match = text.match(/^Follow up with (.+?) (within .+|as arranged\.?|as directed\.?)$/i);
  if (!match) return [text];
  const people = match[1].split(/,\s*and\s+|,\s*|\s+and\s+/i).map((part) => part.trim()).filter(Boolean);
  return people.length > 1 && people.length <= 4
    ? people.map((person) => `Follow up with ${person} ${match[2]}`)
    : [text];
}

export function draftCarePlan(source) {
  const rawSteps = bulletsInSection(source, "Discharge Instructions", /^\s*(?:Return Precautions|Nursing Discharge Teaching|Example\s+\d+)\b/i);
  const steps = rawSteps.length
    ? rawSteps
    : source.split(/\r?\n/).map((line) => line.replace(/^\s*(?:[•*-]|\d+[.)])\s*/, "").trim()).filter(Boolean);
  const items = steps.flatMap((sourceText) => splitFollowUp(sourceText).map((text) => ({
    text: text.replace(/\.$/, ""),
    category: categoryFor(text),
    frequency: frequencyFor(text),
    source: sourceText,
    done: false,
  })));
  const warnings = [
    ...bulletsInSection(source, "Return Precautions", /^\s*(?:Warning Signs|Nursing Discharge Teaching|Example\s+\d+)\b/i),
    ...bulletsInSection(source, "Warning Signs", /^\s*(?:Return Precautions|Nursing Discharge Teaching|Example\s+\d+)\b/i),
  ];
  const medicationChanges = {
    before: medicationList(source, medicationHeadings.before),
    after: medicationList(source, medicationHeadings.after),
  };
  return { items, warnings, medicationChanges, hasDischargeSection: rawSteps.length > 0 };
}
