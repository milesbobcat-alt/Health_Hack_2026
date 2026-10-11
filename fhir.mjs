import { randomUUID } from 'node:crypto';

export const DEFAULT_FHIR_BASE_URL = 'https://r4.smarthealthit.org';
const idPattern = /^[A-Za-z0-9.-]{1,64}$/;
export class FhirError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

export function patientSummary(patient) {
  if (patient?.resourceType !== 'Patient' || !idPattern.test(patient.id || '')) {
    throw new FhirError('The sandbox returned an invalid patient record.');
  }
  const names = Array.isArray(patient.name) ? patient.name : [];
  const name = names.find(n => n.use === 'official') || names[0];
  const parts = [...(Array.isArray(name?.given) ? name.given : []), name?.family].filter(p => typeof p === 'string' && p.trim());
  return { id: patient.id, name: parts.join(' ') || name?.text || 'Name unavailable', birthDate: patient.birthDate || null };
}

const undocumented = 'Not documented';
const conceptText = value => value?.text || value?.coding?.map(c => c.display || c.code).filter(Boolean).join('; ') || null;
const quantityText = value => value && value.value !== undefined ? `${value.comparator || ''}${value.value}${value.unit || value.code ? ` ${value.unit || value.code}` : ''}` : null;
const rangeText = value => value ? `${quantityText(value.low) || '?'} to ${quantityText(value.high) || '?'}` : null;
const periodText = value => value ? `${value.start || 'Start not documented'} — ${value.end || 'End not documented'}` : null;
function timingText(timing) {
  if (!timing) return undocumented;
  const parts = [];
  if (conceptText(timing.code)) parts.push(conceptText(timing.code));
  if (timing.event?.length) parts.push(`Dates/times: ${timing.event.join(', ')}`);
  const repeat = timing.repeat || {};
  const consumed = new Set();
  const units = { s: 'second', min: 'minute', h: 'hour', d: 'day', wk: 'week', mo: 'month', a: 'year' };
  if (repeat.frequency !== undefined && repeat.period !== undefined && repeat.periodUnit) {
    const frequency = `${repeat.frequency}${repeat.frequencyMax !== undefined ? `–${repeat.frequencyMax}` : ''}`;
    const period = `${repeat.period}${repeat.periodMax !== undefined ? `–${repeat.periodMax}` : ''}`;
    const unit = units[repeat.periodUnit] || repeat.periodUnit;
    parts.push(`${frequency} ${repeat.frequency === 1 && repeat.frequencyMax === undefined ? 'time' : 'times'} every ${period} ${unit}${repeat.period === 1 && repeat.periodMax === undefined ? '' : 's'}`);
    for (const key of ['frequency', 'frequencyMax', 'period', 'periodMax', 'periodUnit']) consumed.add(key);
  }
  const labels = { frequency: 'Frequency', frequencyMax: 'Maximum frequency', period: 'Period', periodMax: 'Maximum period', periodUnit: 'Period unit', duration: 'Duration', durationMax: 'Maximum duration', durationUnit: 'Duration unit', count: 'Count', countMax: 'Maximum count', dayOfWeek: 'Days', timeOfDay: 'Times', when: 'When', offset: 'Offset in minutes' };
  for (const [key, value] of Object.entries(timing.repeat || {})) {
    if (key === 'extension' || key === 'id' || value === undefined || consumed.has(key)) continue;
    const display = key === 'boundsPeriod' ? periodText(value) : key === 'boundsDuration' ? quantityText(value) : key === 'boundsRange' ? rangeText(value) : Array.isArray(value) ? value.join(', ') : String(value);
    parts.push(`${labels[key] || 'Schedule bounds'}: ${display}`);
  }
  return parts.join('; ') || undocumented;
}
function statementSummary(statement, medication, warning = null) {
  return {
    id: statement.id || null,
    source: statement.resourceType,
    // Display literal strength text from a coded product label, separately from ingredient strength.
    labelStrength: (() => {
      const coded = statement.medicationCodeableConcept || medication?.code;
      const label = conceptText(coded);
      if (!coded?.coding?.length || !label || label.includes('/')) return null;
      const matches = label.match(/\b\d+(?:\.\d+)?\s*(?:mcg|mg|g)\b/gi);
      return matches?.length === 1 ? matches[0] : null;
    })(),
    notes: (statement.note || []).map(n => n.text).filter(Boolean).join('; ') || null,
    recordedOn: statement.dateAsserted || statement.authoredOn || null,
    recordedLabel: statement.resourceType === 'MedicationRequest' ? 'Order recorded' : 'Statement recorded',
    name: conceptText(statement.medicationCodeableConcept) || conceptText(medication?.code) || statement.medicationReference?.display || undocumented,
    strength: medication?.ingredient?.map(i => {
      const numerator = quantityText(i.strength?.numerator);
      if (!numerator) return null;
      const denominator = quantityText(i.strength?.denominator);
      const ingredient = conceptText(i.itemCodeableConcept) || i.itemReference?.display;
      return `${ingredient ? `${ingredient}: ` : ''}${numerator}${denominator ? ` / ${denominator}` : ''}`;
    }).filter(Boolean).join('; ') || undocumented,
    status: statement.status || undocumented,
    effective: statement.effectiveDateTime || periodText(statement.effectivePeriod) || undocumented,
    warning,
    dosages: ((statement.dosage || statement.dosageInstruction)?.length ? (statement.dosage || statement.dosageInstruction) : [{}]).map(d => ({
      dose: d.doseAndRate?.map(v => quantityText(v.doseQuantity) || rangeText(v.doseRange)).filter(Boolean).join('; ') || undocumented,
      timing: timingText(d.timing),
      asNeeded: d.asNeededBoolean === true ? 'Yes' : d.asNeededBoolean === false ? 'No' : conceptText(d.asNeededCodeableConcept) || undocumented,
      text: d.text || undocumented,
      route: conceptText(d.route) || undocumented,
      additionalInstructions: [d.patientInstruction, ...(d.additionalInstruction || []).map(conceptText)].filter(Boolean).join('; ') || null,
      // Preserve complex schedules and dosage alternatives for later comparison work.
      raw: d,
    })),
  };
}

export function createFhirClient({ baseUrl = DEFAULT_FHIR_BASE_URL, fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  let base;
  try { base = new URL(baseUrl); } catch { throw new Error('FHIR_BASE_URL must be a valid URL.'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error('FHIR_BASE_URL must be an HTTP(S) URL without credentials, query, or fragment.');
  }
  const basePath = base.pathname.replace(/\/$/, '');
  const server = `${base.origin}${basePath}`;
  const cursors = new Map();

  function allowedUrl(value) {
    let url;
    try { url = new URL(value, `${server}/`); } catch { throw new FhirError('The sandbox returned an invalid pagination link.'); }
    const path = url.pathname.replace(/\/$/, '');
    if (url.origin !== base.origin || url.username || url.password || url.hash || !(path === basePath || path.startsWith(`${basePath}/`))) {
      throw new FhirError('The sandbox returned an unsafe pagination link.');
    }
    return url;
  }
  async function requestJson(url) {
    try {
      const response = await fetchImpl(url.href, { headers: { Accept: 'application/fhir+json' }, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
      if (!response.ok) throw new FhirError(response.status === 404 ? 'Patient not found in the sandbox.' : 'The FHIR sandbox rejected the request. Try again later.', response.status === 404 ? 404 : 502);
      const result = await response.json();
      if (!result || result.resourceType === 'OperationOutcome') throw new FhirError('The FHIR sandbox could not complete the request.');
      return result;
    } catch (error) {
      if (error instanceof FhirError) throw error;
      throw new FhirError(error.name === 'TimeoutError' || error.name === 'AbortError' ? 'The FHIR sandbox timed out. Please try again.' : 'Could not read a response from the FHIR sandbox. Please try again.');
    }
  }
  function saveCursor(value) {
    const url = allowedUrl(value);
    const now = Date.now();
    for (const [key, entry] of cursors) if (entry.expires < now) cursors.delete(key);
    if (cursors.size >= 200) cursors.delete(cursors.keys().next().value);
    const token = randomUUID();
    cursors.set(token, { url, expires: now + 10 * 60 * 1000 });
    return token;
  }
  return {
    server,
    async searchPatients({ name, cursor } = {}) {
      let url;
      if (cursor !== undefined) {
        if (name !== undefined || typeof cursor !== 'string' || !cursors.has(cursor) || cursors.get(cursor).expires < Date.now()) {
          throw new FhirError('This results page has expired or is invalid. Search again.', 400);
        }
        url = cursors.get(cursor).url;
      } else {
        if (typeof name !== 'string' || !name.trim() || name.trim().length > 100 || /[\x00-\x1f\x7f]/.test(name)) {
          throw new FhirError('Enter a patient name of 1 to 100 characters.', 400);
        }
        url = new URL(`${server}/Patient`);
        const words = name.trim().split(/\s+/);
        if (words.length === 1) url.searchParams.set('name', words[0]);
        else {
          // FHIR repeated given parameters mean AND; full names are given name(s), then family.
          for (const given of words.slice(0, -1)) url.searchParams.append('given', given);
          url.searchParams.set('family', words.at(-1));
        }
        url.searchParams.set('_count', '10');
      }
      const bundle = await requestJson(url);
      if (bundle.resourceType !== 'Bundle' || bundle.type !== 'searchset' || (bundle.entry !== undefined && !Array.isArray(bundle.entry))) {
        throw new FhirError('The sandbox returned invalid search results.');
      }
      const patients = (bundle.entry || []).filter(e => e.resource?.resourceType === 'Patient' && e.search?.mode !== 'include').map(e => patientSummary(e.resource));
      const next = bundle.link?.find(link => link.relation === 'next');
      return { server, patients, nextCursor: next ? saveCursor(next.url) : null };
    },
    async getMedicationStatements(id, resourceType = 'MedicationStatement') {
      if (!['MedicationStatement', 'MedicationRequest'].includes(resourceType)) throw new FhirError('Unsupported medication resource.', 400);
      if (typeof id !== 'string' || !idPattern.test(id)) throw new FhirError('Invalid patient ID.', 400);
      const initial = new URL(`${server}/${resourceType}`);
      initial.searchParams.set('patient', id);
      initial.searchParams.set('_count', '50');
      const statements = new Map();
      const medications = new Map();
      const visited = new Set();
      let url = initial;
      while (url) {
        if (visited.has(url.href) || visited.size >= 50) throw new FhirError('Medication pagination could not be completed. Please try again.');
        visited.add(url.href);
        const bundle = await requestJson(url);
        if (bundle.resourceType !== 'Bundle' || bundle.type !== 'searchset' || (bundle.entry !== undefined && !Array.isArray(bundle.entry))) throw new FhirError('The sandbox returned invalid medication results.');
        for (const entry of bundle.entry || []) {
          const resource = entry.resource;
          if (resource?.resourceType === 'Medication') {
            if (idPattern.test(resource.id || '')) medications.set(`${server}/Medication/${resource.id}`, Promise.resolve(resource));
          } else if (resource?.resourceType === resourceType) {
            const subject = resource.subject?.reference;
            if (subject !== `Patient/${id}` && subject !== `${server}/Patient/${id}`) throw new FhirError('The sandbox returned medication statements for a different patient.');
            statements.set(resource.id || `anonymous-${statements.size}`, resource);
          }
        }
        if (statements.size > 2000) throw new FhirError('Too many medication statements to display.');
        const next = bundle.link?.find(link => link.relation === 'next');
        url = next ? allowedUrl(next.url) : null;
      }
      async function resolveMedication(statement) {
        const reference = statement.medicationReference?.reference;
        if (!reference) return statementSummary(statement, null);
        if (reference.startsWith('#')) {
          const medication = statement.contained?.find(r => r.id === reference.slice(1) && r.resourceType === 'Medication');
          return statementSummary(statement, medication, medication ? null : 'Referenced medication details were not found.');
        }
        // No credentials, redirects, foreign servers, or references to other resource types.
        const target = allowedUrl(reference);
        const relative = target.pathname.slice(basePath.length);
        const match = relative.match(/^\/Medication\/([A-Za-z0-9.-]{1,64})(?:\/_history\/[A-Za-z0-9.-]{1,64})?$/);
        if (!match || target.search) throw new FhirError('The sandbox returned an unsafe medication reference.');
        if (!medications.has(target.href)) medications.set(target.href, requestJson(target).then(resource => {
          if (resource.resourceType !== 'Medication' || resource.id !== match[1]) throw new FhirError('The sandbox returned invalid medication details.');
          return resource;
        }));
        try { return statementSummary(statement, await medications.get(target.href)); }
        catch (error) {
          if (error.status === 404) return statementSummary(statement, null, 'Referenced medication details were not found.');
          throw error;
        }
      }
      const results = [];
      const records = [...statements.values()];
      for (let start = 0; start < records.length; start += 5) results.push(...await Promise.all(records.slice(start, start + 5).map(resolveMedication)));
      return { server, patientId: id, statements: results };
    },

    async getMedicationRequests(id) {
      return this.getMedicationStatements(id, 'MedicationRequest');
    },
    async getPatient(id) {
      if (typeof id !== 'string' || !idPattern.test(id)) throw new FhirError('Invalid patient ID.', 400);
      const patient = await requestJson(new URL(`${server}/Patient/${encodeURIComponent(id)}`));
      const summary = patientSummary(patient);
      if (summary.id !== id) throw new FhirError('The sandbox returned a different patient than requested.');
      return { server, patient: summary };
    },
  };
}
