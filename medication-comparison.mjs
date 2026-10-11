export const transitionKeys = ['before', 'continue', 'begin', 'stop'];
export const comparisonFields = ['name', 'formulation', 'strength', 'dose', 'frequency', 'instructions'];
const clean = value => typeof value === 'string' && value.trim() && value.trim() !== 'Not documented' ? value.trim() : null;
const norm = value => (clean(value) || '').toLowerCase().replace(/\s+/g, ' ');
export function separateDose(item) {
  const med = {...item};
  if (med.dose && (/^\s*\d+(?:\.\d+)?\s*(?:mg|mcg|g)\b/i.test(med.dose) || norm(med.dose) === norm(med.strength))) {
    med.instructions = [med.instructions, `Documented total amount: ${med.dose}. Unit count not documented.`].filter(Boolean).join('; ');
    med.dose = null;
  }
  return med;
}
export function validateTransitions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !transitionKeys.includes(key))) throw new Error('Invalid medication transition groups.');
  const output = {};
  for (const group of transitionKeys) {
    if (!Array.isArray(value[group]) || value[group].length > 1000) throw new Error(`Invalid ${group} medication list.`);
    output[group] = value[group].map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => ![...comparisonFields,'sources'].includes(key))) throw new Error('Invalid comparison medication fields.');
      if (!clean(item.name)) throw new Error('Comparison medications require a name.');
      for (const field of comparisonFields) if (item[field] !== undefined && item[field] !== null && (typeof item[field] !== 'string' || item[field].length > 4000)) throw new Error(`Invalid medication ${field}.`);
      if (item.sources !== undefined && (!Array.isArray(item.sources) || item.sources.some(source => !['PDF','Transcript','FHIR','Nurse review'].includes(source)))) throw new Error('Invalid medication provenance.');
      return separateDose({...Object.fromEntries(comparisonFields.map(field => [field,clean(item[field])])),sources:[...new Set(item.sources || [])]});
    });
  }
  return output;
}
const emptyGroups = () => Object.fromEntries(transitionKeys.map(key => [key,[]]));
export function mergeTransitionSources(plans) {
  const groups = emptyGroups();
  for (const {source,checklist} of plans) {
    if (!checklist.medicationTransitions) continue;
    const parsed = validateTransitions(checklist.medicationTransitions);
    for (const key of transitionKeys) groups[key].push(...parsed[key].map(item => ({...item,sources:[source]})));
  }
  return groups;
}
export function fhirBaseline(records) {
  return records.filter(item => clean(item.name) && !['medication','name unavailable'].includes(norm(item.name))).map(item => {
    const instructions = (item.dosages || []).flatMap(d => [clean(d.text),clean(d.additionalInstructions),d.asNeeded === 'Yes' ? 'As needed' : d.asNeeded !== 'No' ? clean(d.asNeeded) : null]).filter(Boolean).join('; ');
    return separateDose({name:item.name,formulation:null,strength:clean(item.strength) || clean(item.labelStrength),dose:(item.dosages || []).map(d => clean(d.dose)).filter(Boolean).join('; ') || null,
      frequency:(item.dosages || []).map(d => clean(d.timing)).filter(Boolean).join('; ') || null,instructions:instructions || null,sources:['FHIR']});
  });
}
function identity(item) {
  let name = norm(item.name);
  const explicitForm = norm(item.formulation).replace(/-/g,' ').replace(/\boral\b/g,'').replace(/\s+/g,' ').trim();
  const release = name.match(/\b(extended[- ]release|delayed[- ]release|immediate[- ]release)\b/)?.[0]?.replace(/-/g,' ');
  const dosageForm = name.match(/\b(tablet|capsule|solution|cream|ointment|inhaler|injection)\b/)?.[0];
  const form = explicitForm || [release,dosageForm].filter(Boolean).join(' ');
  name = name.replace(/\b\d+(?:\.\d+)?\s*(?:mg|mcg|g|ml)\b/g,'').replace(/\b(oral|tablet|capsule|solution|cream|ointment|inhaler|injection)\b/g,'')
    .replace(/\b(extended[- ]release|delayed[- ]release|immediate[- ]release)\b/g,'').replace(/\s+/g,' ').trim();
  return {name,form};
}
function compatible(a,b) {
  const x=identity(a), y=identity(b);return x.name===y.name && (!x.form || !y.form || x.form===y.form);
}
// Compare equivalent documented wording; do not calculate doses or convert units.
function fieldValue(field,value) {
  let text=norm(value);
  if (field==='frequency') {
    const schedules={
      daily:'1/day','once daily':'1/day','once a day':'1/day','every day':'1/day','1 time every 1 day':'1/day',
      'twice daily':'2/day','twice a day':'2/day','2 times every 1 day':'2/day',
      'three times daily':'3/day','3 times every 1 day':'3/day',
      weekly:'1/week','once weekly':'1/week','once a week':'1/week','1 time every 1 week':'1/week',
      'twice weekly':'2/week','twice a week':'2/week','2 times every 1 week':'2/week'
    };
    return schedules[text] || text;
  }
  if (field==='dose') {
    const counts={one:'1',two:'2',three:'3',four:'4',five:'5'};
    text=text.replace(/^(one|two|three|four|five)\b/,word=>counts[word]).replace(/\b(tablet|capsule|puff|unit)s\b/g,'$1');
  }
  if (field==='strength') {
    if(!text.includes(';'))text=text.replace(/^[^:]+:\s*(?=\d)/,'');
    text=text.replace(/\s*(?:\/|per)\s*1?\s*(?:tablet|capsule)s?$/,'');
  }
  return text.replace(/(\d)\s+(?=(?:mg|mcg|g|tablet|capsule|puff|unit)\b)/g,'$1');
}
function mergeFields(previous,next,{override=false}={}) {
  const med={...previous,sources:[...new Set([...(previous.sources || []),...(next.sources || [])])]};
  const conflicts=[];
  for (const field of ['formulation','strength','dose','frequency']) {
    if (!next[field]) continue;
    if (!previous[field] && /REVIEW REQUIRED/.test(previous.instructions || "") && !override) continue;
    if (previous[field] && fieldValue(field,previous[field])!==fieldValue(field,next[field]) && !override) {med[field]=null;conflicts.push(`${field}: ${previous[field]} versus ${next[field]}`);}
    else med[field]=next[field];
  }
  med.instructions=[previous.instructions,next.instructions,conflicts.length ? `REVIEW REQUIRED: conflicting source values (${conflicts.join('; ')}).` : null].filter(Boolean).filter((v,i,arr)=>arr.indexOf(v)===i).join('; ') || null;
  return med;
}
export function buildMedicationComparison(comparison) {
  const groups=validateTransitions(comparison.groups);const baseline=comparison.baseline || [];
  const rows=[];
  function rowFor(item) {
    const matches=rows.filter(row => compatible(row.identity,item));
    if (matches.length===1) return matches[0];
    const row={identity:item,before:null,after:null,action:null,warning:matches.length ? 'REVIEW REQUIRED: formulation is ambiguous.' : null,explicitBefore:false};rows.push(row);return row;
  }
  for (const item of baseline) {const row=rowFor(item);row.before=row.before ? mergeFields(row.before,item) : {...item};}
  for (const item of groups.before) {
    const row=rowFor(item);row.before=row.before ? mergeFields(row.before,item,{override:!row.explicitBefore}) : {...item};row.explicitBefore=true;
  }
  for (const action of ['begin','continue','stop']) for (const item of groups[action]) {
    const row=rowFor(item);
    if (row.action && row.action !== action) {row.warning='REVIEW REQUIRED: conflicting discharge actions.';row.action='unknown';}
    else if (row.action !== 'unknown') row.action=action;
    row.after=row.after ? mergeFields(row.after,item) : {...item};
  }
  for (const row of rows) {
    if (row.action==='continue' && row.before && row.after && ['strength','dose','frequency'].some(field => row.before[field] && row.after[field] && fieldValue(field,row.before[field])!==fieldValue(field,row.after[field]))) row.action='begin';
    if (/REVIEW REQUIRED/.test([row.before?.instructions,row.after?.instructions].filter(Boolean).join('; '))) row.warning=[row.warning,'REVIEW REQUIRED: check conflicting values against the sources.'].filter(Boolean).join(' ');
    row.unverified=Boolean(row.before && !row.explicitBefore);
  }
  const order={begin:0,continue:1,stop:2,unknown:3};
  return rows.sort((a,b)=>(order[a.action] ?? 3)-(order[b.action] ?? 3)||a.identity.name.localeCompare(b.identity.name));
}
export function reclassifyChangedRegimens(comparison) {
  const rows = buildMedicationComparison(comparison);
  const changed = comparison.groups.continue.filter(item => rows.some(row => row.action === 'begin' && compatible(row.identity,item)));
  comparison.groups.continue = comparison.groups.continue.filter(item => !changed.includes(item));
  comparison.groups.begin.push(...changed);
  return comparison;
}
function regimen(med) {
  const details=[med.strength ? `strength ${med.strength}` : null,med.dose ? `dose ${med.dose}` : null,med.frequency].filter(Boolean);
  const formulation = med.formulation && !med.name.toLowerCase().includes(med.formulation.toLowerCase()) ? ` (${med.formulation})` : '';
  const text = `${med.name}${formulation}${details.length ? ` — ${details.join(', ')}` : ''}${med.instructions ? `. ${med.instructions}` : ''}`;
  return /[.!?]$/.test(text) ? text : `${text}.`;
}
export function comparisonSentences(row) {
  const before=row.before ? `Took ${regimen(row.before)}` : 'Prior medication information not provided';
  const after=row.warning && row.action==='unknown' ? 'REVIEW REQUIRED: conflicting discharge actions' : row.action==='stop' ? `Stop taking ${row.after.name}.` : row.after && ['begin','continue'].includes(row.action) ? `${row.action==='begin' ? 'Begin' : 'Continue'} taking ${regimen(row.after)}` : 'Discharge information not provided';
  return {before,after};
}
export function validateComparison(value,server) {
  if (!value || typeof value!=='object' || Array.isArray(value)) throw new Error('Invalid medication comparison.');
  const groups=validateTransitions(value.groups);
  const baseline=validateTransitions({before:value.baseline || [],continue:[],begin:[],stop:[]}).before;
  let patient=null;
  if (value.patient) {
    if (value.patient.server!==server || typeof value.patient.id!=='string' || !/^[A-Za-z0-9.-]{1,64}$/.test(value.patient.id)) throw new Error('Invalid comparison patient or FHIR server.');
    patient={id:value.patient.id,server};
  }
  if (!Array.isArray(value.warnings || []) || (value.warnings || []).some(v=>typeof v!=='string' || v.length>4000)) throw new Error('Invalid comparison warnings.');
  return reclassifyChangedRegimens({patient,baseline,groups,warnings:value.warnings || []});
}
