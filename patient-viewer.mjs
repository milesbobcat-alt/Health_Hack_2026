import { createPatientContext, createMedicationLoader } from "./patient-state.mjs";

export function initializePatientViewer({ hasDraft, clearDraft, isBusy }) {
  const patientContext = createPatientContext();
  const patientForm = document.querySelector('#patient-search-form');
  const patientName = document.querySelector('#patient-name');
  const patientResults = document.querySelector('#patient-results');
  const patientStatus = document.querySelector('#patient-status');
  const loadMore = document.querySelector('#load-more-patients');
  const selectedPanel = document.querySelector('#selected-patient');
  const selectedDetails = document.querySelector('#selected-patient-details');
  const changePatient = document.querySelector('#change-patient');
  const medicationDetails = document.querySelector('#medication-details');
  const medicationList = document.querySelector('#medication-list');
  const medicationStatus = document.querySelector('#medication-status');
  const medicationRetry = document.querySelector('#medication-retry');
  function medicationField(list, label, value) {
    const term = document.createElement('dt');
    if (!value || value === 'Not documented') return;
    term.textContent = label;
    const definition = document.createElement('dd');
    definition.textContent = value || 'Not documented';
    list.append(term, definition);
  }
  const medicationLoader = createMedicationLoader(
    async (id, signal) => {
      const kinds = ['statements', 'requests'];
      const responses = await Promise.allSettled(kinds.map(kind => patientJson(`/api/patients/${encodeURIComponent(id)}/medication-${kind}`, signal)));
      if (signal.aborted) throw new DOMException('Canceled', 'AbortError');
      const successful = responses.filter(r => r.status === 'fulfilled').map(r => r.value);
      if (!successful.length) throw responses[0].reason;
      const first = successful[0];
      if (successful.some(r => r.patientId !== first.patientId || r.server !== first.server)) throw new Error('The medication source changed. Select the patient again.');
      return { ...first, statements: successful.flatMap(r => r.statements), warnings: responses.flatMap((r, index) => r.status === 'rejected' ? [`Could not load medication ${kinds[index]}: ${r.reason.message}`] : []) };
    },
    ({ state, result, message }) => {
      medicationList.replaceChildren();
      medicationRetry.hidden = state !== 'error';
      medicationList.setAttribute('aria-busy', String(state === 'loading'));
      medicationStatus.dataset.state = state;
      const records = result?.statements || [];
      const statementCount = records.filter(r => r.source === 'MedicationStatement').length;
      const prescriptionCount = records.filter(r => r.source === 'MedicationRequest').length;
      medicationStatus.textContent = state === 'loading' ? 'Loading medication records…'
        : state === 'error' ? message
        : state === 'loaded' ? `${statementCount} statement records; ${prescriptionCount} prescription records. ${records.length ? 'Missing fields are omitted.' : 'No medication records found.'}${result.warnings?.length ? ` ${result.warnings.join(' ')}` : ''}` : '';
      let previousSource = null;
      for (const statement of result?.statements || []) {
        if (statement.source !== previousSource) {
          const group = document.createElement('li');
          group.className = 'medication-group';
          const title = document.createElement('h3');
          title.textContent = statement.source === 'MedicationRequest' ? 'Prescription records' : 'Medication statements';
          group.append(title);
          medicationList.append(group);
          previousSource = statement.source;
        }
        const item = document.createElement('details');
        item.className = 'medication-record';
        const heading = document.createElement('summary');
        const unnamed = !statement.name || ['Medication', 'Not documented'].includes(statement.name);
        heading.textContent = unnamed ? 'Unnamed medication record' : statement.name;
        if (statement.status && statement.status !== 'Not documented') {
          const badge = document.createElement('span');
          badge.className = 'medication-status-badge';
          badge.textContent = statement.status;
          heading.append(badge);
        }
        const fields = document.createElement('dl');
        medicationField(fields, 'Strength', statement.strength);
        if (statement.strength === 'Not documented') medicationField(fields, 'Strength in product name', statement.labelStrength);
        medicationField(fields, 'Status', statement.status);
        medicationField(fields, statement.recordedLabel || 'Recorded', statement.recordedOn);
        medicationField(fields, 'Notes', statement.notes);
        medicationField(fields, 'Effective dates', statement.effective);
        if (statement.warning) medicationField(fields, 'Details unavailable', statement.warning);
        item.append(heading, fields);
        const missing = [];
        if (unnamed) missing.push('drug name');
        if (statement.strength === 'Not documented' && !statement.labelStrength) missing.push('strength');
        if (statement.dosages.every(d => d.dose === 'Not documented')) missing.push('dose');
        if (statement.dosages.every(d => d.timing === 'Not documented' && d.text === 'Not documented')) missing.push('timing');
        if (missing.length) {
          const explanation = document.createElement('p');
          explanation.textContent = `This ${statement.source === 'MedicationRequest' ? 'prescription' : 'statement'} record does not provide: ${missing.join(', ')}.`;
          item.append(explanation);
        }
        statement.dosages.forEach((dosage, index) => {
          if (statement.dosages.length > 1) {
            const title = document.createElement('h5');
            title.textContent = `Dosage instruction ${index + 1}`;
            item.append(title);
          }
          const instructions = document.createElement('dl');
          medicationField(instructions, 'Dose', dosage.dose);
          medicationField(instructions, 'Timing / frequency', dosage.timing);
          medicationField(instructions, 'As needed', dosage.asNeeded);
          medicationField(instructions, 'Route', dosage.route);
          medicationField(instructions, 'Dosage text', dosage.text);
          if (dosage.additionalInstructions) medicationField(instructions, 'Additional instructions', dosage.additionalInstructions);
          if (instructions.children.length) item.append(instructions);
        });
        const row = document.createElement('li');
        row.append(item);
        medicationList.append(row);
      }
    },
  );
  medicationDetails.addEventListener('toggle', () => {
    if (medicationDetails.open) void medicationLoader.load(patientContext.selected);
  });
  medicationRetry.addEventListener('click', () => void medicationLoader.load(patientContext.selected));

  const switchConfirmation = document.querySelector('#patient-change-confirmation');
  const confirmSwitch = document.querySelector('#confirm-patient-change');
  const cancelSwitch = document.querySelector('#cancel-patient-change');
  let pendingPatientSwitch = null;
  let patientRequest = null;
  let patientVersion = 0;
  let nextCursor = null;
  let foundPatients = new Map();

  function patientMessage(message, error = false) {
    patientStatus.textContent = message;
    patientStatus.dataset.state = error ? 'error' : 'idle';
  }
  function cancelPatientRequest() {
    patientVersion++;
    pendingPatientSwitch = null;
    switchConfirmation.hidden = true;
    patientRequest?.abort();
    patientRequest = null;
    patientResults.removeAttribute('aria-busy');
    loadMore.disabled = false;
  }
  function clearCareDraft() { clearDraft(); }
  function switchOptions(approved = false) {
    return {
      hasDraft: hasDraft(),
      confirmDiscard: () => approved,
      clearDraft: clearCareDraft,
    };
  }
  function requestPatientSwitch(operation) {
    if (switchOptions().hasDraft) {
      pendingPatientSwitch = operation;
      switchConfirmation.hidden = false;
      patientMessage('Review the draft-clearing confirmation before changing patient.');
      cancelSwitch.focus();
    } else operation();
  }
  confirmSwitch.addEventListener('click', () => {
    if (isBusy()) {
      patientMessage('Finish recording, transcription, generation, or saving before changing patients.', true);
      return;
    }
    const operation = pendingPatientSwitch;
    pendingPatientSwitch = null;
    switchConfirmation.hidden = true;
    operation?.();
  });
  cancelSwitch.addEventListener('click', () => {
    pendingPatientSwitch = null;
    switchConfirmation.hidden = true;
    patientMessage('Patient change canceled. Your current instructions and PDF were kept.');
    patientName.focus();
  });
  function renderSelectedPatient() {
    medicationLoader.reset();
    medicationDetails.open = false;
    const selected = patientContext.selected;
    selectedPanel.hidden = !selected;
    selectedDetails.textContent = selected
      ? `${selected.patient.name} · Date of birth: ${selected.patient.birthDate || 'Unavailable'} · Patient ID: ${selected.patient.id}`
      : '';
    document.dispatchEvent(new CustomEvent('patient-context-changed', { detail: selected }));
  }
  function renderPatientResults() {
    patientResults.replaceChildren();
    for (const result of foundPatients.values()) {
      const item = document.createElement('li');
      const details = document.createElement('p');
      details.textContent = `${result.patient.name} · Date of birth: ${result.patient.birthDate || 'Unavailable'} · Patient ID: ${result.patient.id}`;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Select patient';
      button.setAttribute('aria-label', `Select ${result.patient.name}, patient ID ${result.patient.id}`);
      button.addEventListener('click', () => void selectPatient(result));
      item.append(details, button);
      patientResults.append(item);
    }
  }
  async function patientJson(path, signal) {
    const response = await fetch(path, { signal });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'The patient request failed.');
    return result;
  }
  async function searchPatients(more = false) {
    cancelPatientRequest();
    const version = patientVersion;
    const request = new AbortController();
    patientRequest = request;
    const params = new URLSearchParams();
    if (more) params.set('cursor', nextCursor);
    else {
      params.set('name', patientName.value.trim());
      foundPatients = new Map();
      nextCursor = null;
      renderPatientResults();
      loadMore.hidden = true;
    }
    patientResults.setAttribute('aria-busy', 'true');
    loadMore.disabled = true;
    patientMessage('Searching the sandbox…');
    try {
      const result = await patientJson(`/api/patients?${params}`, request.signal);
      if (version !== patientVersion) return;
      for (const patient of result.patients) foundPatients.set(patient.id, { server: result.server, patient });
      nextCursor = result.nextCursor;
      renderPatientResults();
      loadMore.hidden = !nextCursor;
      patientMessage(foundPatients.size ? `${foundPatients.size} matching ${foundPatients.size === 1 ? 'patient' : 'patients'} shown. Select the correct patient.` : 'No matching patients. Try a first name, last name, or first and last name.');
    } catch (error) {
      if (version === patientVersion && error.name !== 'AbortError') patientMessage(error instanceof TypeError ? 'Could not reach the server. Check that the app is running.' : error.message, true);
    } finally {
      if (version === patientVersion) {
        patientResults.removeAttribute('aria-busy');
        loadMore.disabled = false;
        patientRequest = null;
      }
    }
  }
  async function selectPatient(result) {
    if (isBusy()) {
      patientMessage('Finish recording, transcription, generation, or saving before changing patients.', true);
      return;
    }
    cancelPatientRequest();
    const version = patientVersion;
    const request = new AbortController();
    patientRequest = request;
    patientMessage('Loading the selected patient…');
    try {
      const current = await patientJson(`/api/patients/${encodeURIComponent(result.patient.id)}`, request.signal);
      if (version !== patientVersion) return;
      if (isBusy()) {
        patientMessage('Finish recording, transcription, generation, or saving before changing patients.', true);
        return;
      }
      if (current.server !== result.server || current.patient.id !== result.patient.id) throw new Error('The patient source changed. Search again.');
      requestPatientSwitch(() => {
        if (!patientContext.select(current, switchOptions(true))) return;
        cancelPatientRequest();
        renderSelectedPatient();
        foundPatients.clear();
        renderPatientResults();
        nextCursor = null;
        loadMore.hidden = true;
        patientMessage('Patient selected.');
        changePatient.focus();
      });
    } catch (error) {
      if (version === patientVersion && error.name !== 'AbortError') patientMessage(error instanceof TypeError ? 'Could not reach the server.' : error.message, true);
    }
  }
  patientForm.addEventListener('submit', event => {
    event.preventDefault();
    void searchPatients();
  });
  patientName.addEventListener('input', () => {
    cancelPatientRequest();
    nextCursor = null;
    foundPatients.clear();
    renderPatientResults();
    loadMore.hidden = true;
    patientMessage('');
  });
  loadMore.addEventListener('click', () => void searchPatients(true));
  changePatient.addEventListener('click', () => {
    if (isBusy()) {
      patientMessage('Finish recording, transcription, generation, or saving before changing patients.', true);
      return;
    }
    cancelPatientRequest();
    requestPatientSwitch(() => {
      if (!patientContext.clear(switchOptions(true))) return;
      cancelPatientRequest();
      renderSelectedPatient();
      patientName.value = '';
      foundPatients.clear();
      renderPatientResults();
      nextCursor = null;
      loadMore.hidden = true;
      patientMessage('Search for another patient.');
      patientName.focus();
    });
  });


  return patientContext;
}
