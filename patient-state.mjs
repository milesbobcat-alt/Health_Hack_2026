// Patient context remains in this page's memory; no clinical data is persisted.
export function createPatientContext() {
  let selected = null;
  return {
    get selected() { return selected; },
    select(result, { hasDraft = false, confirmDiscard = () => false, clearDraft = () => {} } = {}) {
      if (!result?.server || !result.patient?.id) throw new Error('Patient selection requires a server and patient ID.');
      const same = selected?.server === result.server && selected?.patient.id === result.patient.id;
      if (same) return true;
      if (hasDraft && !confirmDiscard()) return false;
      // Clear before replacing context, including an initially unassigned draft.
      clearDraft();
      selected = { server: result.server, patient: { ...result.patient } };
      return true;
    },
    clear({ hasDraft = false, confirmDiscard = () => false, clearDraft = () => {} } = {}) {
      if (hasDraft && !confirmDiscard()) return false;
      clearDraft();
      selected = null;
      return true;
    },
  };
}

// A response belongs to one patient context; reset invalidates even non-abortable requests.
export function createMedicationLoader(fetchStatements, publish) {
  let version = 0;
  let controller = null;
  let cached = null;
  let pendingKey = null;
  return {
    reset() {
      version++;
      controller?.abort();
      controller = null;
      cached = null;
      pendingKey = null;
      publish({ state: 'idle' });
    },
    async load(context) {
      if (!context) return;
      const key = `${context.server}|${context.patient.id}`;
      if (cached?.key === key) { publish({ state: 'loaded', result: cached.result }); return; }
      if (pendingKey === key) return;
      const current = ++version;
      controller?.abort();
      controller = new AbortController();
      pendingKey = key;
      publish({ state: 'loading' });
      try {
        const result = await fetchStatements(context.patient.id, controller.signal);
        if (current !== version) return;
        if (result.server !== context.server || result.patientId !== context.patient.id || !Array.isArray(result.statements)) throw new Error('The medication source changed. Select the patient again.');
        cached = { key, result };
        publish({ state: 'loaded', result });
      } catch (error) {
        if (current === version && error.name !== 'AbortError') publish({ state: 'error', message: error.message || 'Could not load medication statements.' });
      } finally {
        if (current === version) pendingKey = null;
      }
    },
  };
}
