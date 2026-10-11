(() => {
  const initializeTranslation = () => {
    const controlStyles = document.createElement("style");
    controlStyles.textContent = `
      .page-translation-control {
        position: fixed;
        z-index: 1000;
        inset: auto 1rem 1rem auto;
        display: grid;
        grid-template-columns: minmax(10rem, 1fr) auto;
        gap: 0.5rem;
        align-items: center;
        max-width: calc(100vw - 2rem);
        padding: 0.75rem;
        border: 1px solid #cbd5e1;
        border-radius: 0.75rem;
        background: #fff;
        box-shadow: 0 0.25rem 1rem rgb(15 23 42 / 18%);
        color: #172033;
        font: 500 0.875rem/1.4 system-ui, sans-serif;
      }
      .page-translation-control select,
      .page-translation-control button {
        min-height: 2.5rem;
        border: 1px solid #64748b;
        border-radius: 0.4rem;
        padding: 0.45rem 0.65rem;
        background: #fff;
        color: inherit;
        font: inherit;
      }
      .page-translation-control button {
        background: #1d4ed8;
        border-color: #1d4ed8;
        color: #fff;
        cursor: pointer;
      }
      .page-translation-control button:disabled,
      .page-translation-control select:disabled {
        cursor: wait;
        opacity: 0.65;
      }
      .page-translation-control [role="status"] {
        grid-column: 1 / -1;
        margin: 0;
      }
      @media (max-width: 30rem) {
        .page-translation-control {
          inset: auto 0.5rem 0.5rem;
          max-width: none;
        }
      }
    `;
    document.head.append(controlStyles);

    const control = document.createElement("section");
    control.className = "page-translation-control";
    control.dataset.translationControl = "true";
    control.setAttribute("aria-label", "Page translation");

    const languageSelect = document.createElement("select");
    languageSelect.setAttribute("aria-label", "Choose a page language");
    const prompt = document.createElement("option");
    prompt.value = "";
    prompt.textContent = "Choose a language";
    languageSelect.append(prompt);

    const translateButton = document.createElement("button");
    translateButton.type = "button";
    translateButton.textContent = "Translate page";
    translateButton.disabled = true;

    const status = document.createElement("p");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");

    control.append(languageSelect, translateButton, status);
    document.body.append(control);

    const originalLanguage = document.documentElement.lang;
    const originalDirection = document.documentElement.dir;
    let translatedItems = [];
    let isTranslated = false;
    const translateValues = document.body.dataset.translateValues === "true";

    function setBusy(busy) {
      languageSelect.disabled = busy;
      translateButton.disabled = busy || languageSelect.options.length < 2;
    }

    async function readApiJson(response, endpoint) {
      const contentType = response.headers.get("content-type") || "unknown content type";
      const body = await response.text();
      let result;
      try {
        result = JSON.parse(body);
      } catch {
        throw new Error(
          `${endpoint} returned a non-JSON response (HTTP ${response.status}, ${contentType}). Check that the deployed server includes this translation API route.`,
        );
      }
      if (!response.ok) {
        throw new Error(result.error || `${endpoint} failed with HTTP ${response.status}.`);
      }
      return result;
    }

    const translatedAttributes = ["alt", "aria-description", "aria-label", "placeholder", "title", "value"];

    function createTranslationDocument() {
      const clone = document.documentElement.cloneNode(true);
      clone.querySelectorAll("script").forEach((script) => {
        script.textContent = "";
      });
      if (translateValues) {
        for (const field of document.querySelectorAll("textarea[data-translate-value]")) {
          const translatedField = clone.querySelector(`#${CSS.escape(field.id)}`);
          if (translatedField) translatedField.textContent = field.value;
        }
      }
      return `<!DOCTYPE html>\n${clone.outerHTML}`;
    }

    function captureOriginalPage() {
      const state = {
        title: document.title,
        language: document.documentElement.lang,
        direction: document.documentElement.dir,
        textNodes: [],
        attributes: [],
        values: [],
      };
      const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        state.textNodes.push({ node, value: node.nodeValue });
      }
      for (const element of document.documentElement.querySelectorAll("*")) {
        for (const name of translatedAttributes) {
          if (element.hasAttribute(name)) {
            state.attributes.push({ element, name, value: element.getAttribute(name) });
          }
        }
        if (translateValues && element instanceof HTMLTextAreaElement
          && element.hasAttribute("data-translate-value")) {
          state.values.push({ element, value: element.value });
        }
      }
      return state;
    }

    function restoreOriginalPage(state) {
      for (const item of state.textNodes) item.node.nodeValue = item.value;
      for (const item of state.attributes) item.element.setAttribute(item.name, item.value);
      for (const item of state.values) item.element.value = item.value;
      document.title = state.title;
      document.documentElement.lang = state.language;
      document.documentElement.dir = state.direction;
    }

    function applyTranslatedDocument(originalNode, translatedNode) {
      if (!translatedNode || originalNode.nodeType !== translatedNode.nodeType) {
        throw new Error("AWS Translate returned HTML with an unexpected structure.");
      }
      if (originalNode.nodeType === Node.TEXT_NODE) {
        originalNode.nodeValue = translatedNode.nodeValue;
        return;
      }
      if (originalNode.nodeType !== Node.ELEMENT_NODE) return;
      if (originalNode.tagName !== translatedNode.tagName) {
        throw new Error("AWS Translate returned HTML with an unexpected structure.");
      }
      if (originalNode.matches("script, style, [data-translation-control]")) return;

      for (const name of translatedAttributes) {
        if (originalNode.hasAttribute(name) && translatedNode.hasAttribute(name)) {
          originalNode.setAttribute(name, translatedNode.getAttribute(name));
        }
      }
      if (translateValues && originalNode instanceof HTMLTextAreaElement
        && originalNode.hasAttribute("data-translate-value")) {
        originalNode.value = translatedNode.value;
        return;
      }

      if (originalNode.childNodes.length !== translatedNode.childNodes.length) {
        throw new Error("AWS Translate returned HTML with an unexpected structure.");
      }
      for (let index = 0; index < originalNode.childNodes.length; index += 1) {
        applyTranslatedDocument(originalNode.childNodes[index], translatedNode.childNodes[index]);
      }
    }

    function restorePage() {
      restoreOriginalPage(translatedItems);
      translatedItems = [];
      isTranslated = false;
      document.documentElement.lang = originalLanguage;
      document.documentElement.dir = originalDirection;
      translateButton.textContent = "Translate page";
      status.textContent = "Original page text restored.";
      setBusy(false);
    }

    async function loadLanguages() {
      try {
        const response = await fetch("/api/translate/languages");
        const result = await readApiJson(response, "The language-list endpoint");
        if (!Array.isArray(result.languages)) throw new Error("AWS Translate returned an invalid language list.");

        for (const language of result.languages) {
          if (typeof language.code !== "string" || typeof language.name !== "string") continue;
          const option = document.createElement("option");
          option.value = language.code;
          option.textContent = language.name;
          languageSelect.append(option);
        }
        setBusy(false);
        status.textContent = `${result.languages.length} AWS Translate languages available.`;
      } catch (error) {
        status.textContent = error instanceof TypeError
          ? "Could not reach the translation service."
          : error.message || "Available languages could not be loaded.";
      }
    }

    translateButton.addEventListener("click", async () => {
      if (isTranslated) {
        restorePage();
        return;
      }
      const targetLanguage = languageSelect.value;
      if (!targetLanguage) {
        status.textContent = "Choose a language before translating.";
        return;
      }

      setBusy(true);
      status.textContent = "Translating the full page with AWS Translate…";
      const originalState = captureOriginalPage();
      try {
        const html = createTranslationDocument();
        const response = await fetch("/api/translate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ targetLanguage, html }),
        });
        const result = await readApiJson(response, "The translation endpoint");
        if (typeof result.translatedHtml !== "string" || !result.translatedHtml.trim()) {
          throw new Error("AWS Translate returned an invalid HTML document.");
        }
        const translatedDocument = new DOMParser().parseFromString(result.translatedHtml, "text/html");
        if (!translatedDocument.documentElement || !translatedDocument.body) {
          throw new Error("AWS Translate returned an invalid HTML document.");
        }
        applyTranslatedDocument(document.documentElement, translatedDocument.documentElement);
        translatedItems = originalState;
        isTranslated = true;
        document.documentElement.lang = targetLanguage;
        document.documentElement.dir = ["ar", "he", "fa", "ur"].includes(targetLanguage.split("-")[0])
          ? "rtl"
          : "ltr";
        translateButton.textContent = "Show original";
        status.textContent = "Page translated. Verify clinical instructions before relying on them.";
      } catch (error) {
        restoreOriginalPage(originalState);
        status.textContent = error instanceof TypeError
          ? "Could not reach AWS Translate. Check your connection and try again."
          : error.message || "The page could not be translated.";
      } finally {
        setBusy(false);
      }
    });

    void loadLanguages();
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeTranslation, { once: true });
  } else {
    initializeTranslation();
  }
})();
