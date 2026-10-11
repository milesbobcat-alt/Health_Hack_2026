(() => {
  const initializeTranslation = () => {
    const controlStyles = document.createElement("style");
    controlStyles.textContent = `
      .page-translation-control {
        box-sizing: border-box;
        display: grid;
        grid-template-columns: minmax(10rem, 14rem) auto minmax(0, 1fr);
        gap: 0.5rem;
        align-items: center;
        width: min(100% - 3rem, 76rem);
        max-width: 76rem;
        margin: 0 auto 0.75rem;
        padding: 0.75rem;
        border: 1px solid #cbd5e1;
        border-radius: 0.4rem;
        background: #fff;
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
        margin: 0;
      }
      @media (max-width: 30rem) {
        .page-translation-control {
          width: calc(100% - 2rem);
          grid-template-columns: minmax(0, 1fr) auto;
        }
        .page-translation-control [role="status"] {
          grid-column: 1 / -1;
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
    const header = document.querySelector(".patient-header, .page-header");
    if (header) {
      header.append(control);
    } else {
      document.body.prepend(control);
    }

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
      const requestId = response.headers.get("x-request-id");
      let result;
      try {
        result = JSON.parse(body);
      } catch {
        const responseDetail = body.trim().slice(0, 200);
        throw new Error(
          `${endpoint} returned a non-JSON response (HTTP ${response.status}, ${contentType})${responseDetail ? `: ${responseDetail}` : ""}. Check the Lambda/API Gateway logs if this is a server error.`,
        );
      }
      if (!response.ok) {
        const diagnostic = result.diagnostic || {};
        const details = [
          diagnostic.code,
          diagnostic.region ? `region: ${diagnostic.region}` : null,
          diagnostic.requestId || requestId ? `Request ID: ${diagnostic.requestId || requestId}` : null,
        ].filter(Boolean).join("; ");
        throw new Error(
          `${result.error || `${endpoint} failed with HTTP ${response.status}.`}${details ? ` (${details})` : ""}`,
        );
      }
      return result;
    }

    async function fetchApi(url, options, connectionError) {
      try {
        return await fetch(url, options);
      } catch (error) {
        const detail = error instanceof Error && error.message ? ` (${error.message})` : "";
        throw new Error(`${connectionError}${detail}`);
      }
    }

    function createTranslationDocument() {
      const clone = document.documentElement.cloneNode(true);
      clone.querySelectorAll("script").forEach((script) => {
        script.textContent = "";
      });
      clone.querySelectorAll("[data-translation-control]").forEach((control) => control.remove());

      const translationNodes = [];
      const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
      const originalWalker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT);
      const candidates = [];
      const originalCandidates = [];
      let node;
      while ((node = walker.nextNode())) {
        const parent = node.parentElement;
        if (!parent || parent.closest(
          "script, style, noscript, template, [hidden], [aria-hidden='true'], textarea, title",
        ) || !node.nodeValue?.trim()) continue;
        candidates.push(node);
      }
      while ((node = originalWalker.nextNode())) {
        const parent = node.parentElement;
        if (!parent || parent.closest(
          "script, style, noscript, template, [hidden], [aria-hidden='true'], textarea, title, [data-translation-control]",
        ) || !node.nodeValue?.trim()) continue;
        originalCandidates.push(node);
      }
      candidates.forEach((textNode, index) => {
        const marker = clone.ownerDocument.createElement("span");
        marker.id = `translation-text-${index}`;
        marker.textContent = textNode.nodeValue;
        textNode.replaceWith(marker);
        translationNodes.push({
          id: marker.id,
          type: "text",
          originalNode: originalCandidates[index],
        });
      });

      if (translateValues) {
        const valueContainer = clone.ownerDocument.createElement("div");
        valueContainer.id = "translation-values";
        valueContainer.style.cssText = "position:absolute;left:-10000px;top:0";
        for (const field of document.querySelectorAll("textarea[data-translate-value]")) {
          if (!field.value.trim()) continue;
          const marker = clone.ownerDocument.createElement("span");
          marker.id = `translation-value-${translationNodes.length}`;
          marker.textContent = field.value;
          valueContainer.append(marker);
          translationNodes.push({ id: marker.id, type: "value", fieldId: field.id });
        }
        if (valueContainer.childElementCount) {
          const body = clone.querySelector("body");
          if (!body) throw new Error("The page body could not be prepared for translation.");
          body.append(valueContainer);
        }
      }
      return {
        html: `<!DOCTYPE html>\n${clone.outerHTML}`,
        translationNodes,
      };
    }

    function captureOriginalPage() {
      const state = {
        title: document.title,
        language: document.documentElement.lang,
        direction: document.documentElement.dir,
        textNodes: [],
        values: [],
      };
      const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        state.textNodes.push({ node, value: node.nodeValue });
      }
      for (const element of document.documentElement.querySelectorAll("textarea[data-translate-value]")) {
        if (translateValues && element instanceof HTMLTextAreaElement
          ) {
          state.values.push({ element, value: element.value });
        }
      }
      return state;
    }

    function restoreOriginalPage(state) {
      for (const item of state.textNodes) item.node.nodeValue = item.value;
      for (const item of state.values) item.element.value = item.value;
      document.title = state.title;
      document.documentElement.lang = state.language;
      document.documentElement.dir = state.direction;
    }

    function applyTranslatedDocument(translatedDocument, translationNodes) {
      for (const item of translationNodes) {
        const translatedNode = translatedDocument.getElementById(item.id);
        if (!translatedNode) {
          throw new Error("AWS Translate returned HTML without all translated page text.");
        }
        if (item.type === "value") {
          const field = document.getElementById(item.fieldId);
          if (field instanceof HTMLTextAreaElement) field.value = translatedNode.textContent;
        } else {
          if (!item.originalNode) {
            throw new Error("AWS Translate returned HTML with an unexpected text marker.");
          }
          item.originalNode.nodeValue = translatedNode.textContent;
        }
      }
      document.title = translatedDocument.title;
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
        const response = await fetchApi(
          "/api/translate/languages",
          undefined,
          "Could not reach the app's language-list API (/api/translate/languages). Check the API Gateway/Lambda connection.",
        );
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
        status.textContent = error.message || "Available languages could not be loaded.";
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
        const translationDocument = createTranslationDocument();
        const response = await fetchApi(
          "/api/translate",
          {
            method: "POST",
            cache: "no-store",
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "X-Target-Language": targetLanguage,
            },
            body: translationDocument.html,
          },
          "Could not reach the app's translation API (/api/translate). Check the API Gateway/Lambda connection. If this continues, check the browser Network panel.",
        );
        const result = await readApiJson(response, "The translation endpoint");
        if (typeof result.translatedHtml !== "string" || !result.translatedHtml.trim()) {
          throw new Error("AWS Translate returned an invalid HTML document.");
        }
        const translatedDocument = new DOMParser().parseFromString(result.translatedHtml, "text/html");
        if (!translatedDocument.documentElement || !translatedDocument.body) {
          throw new Error("AWS Translate returned an invalid HTML document.");
        }
        applyTranslatedDocument(translatedDocument, translationDocument.translationNodes);
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
        status.textContent = error.message || "The page could not be translated.";
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
