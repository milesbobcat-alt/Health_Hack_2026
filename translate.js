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
        border: 1px solid var(--border, #767676);
        border-radius: 3px;
        background: var(--surface, #fff);
        color: var(--text, #1f1f1f);
        font: inherit;
        font-size: .875rem;
        line-height: 1.4;
      }
      .page-translation-control select,
      .page-translation-control button {
        min-height: 2.5rem;
        border: 1px solid var(--border, #767676);
        border-radius: 3px;
        padding: 0.45rem 0.65rem;
        background: var(--surface, #fff);
        color: inherit;
        font: inherit;
      }
      .page-translation-control button {
        background: var(--link, #3933aa);
        border-color: var(--link, #3933aa);
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
    let version = 0;
    let resumeTranslation = false;
    let translating = false;
    const translationCache = new Map();
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
      const clone = document.implementation.createHTMLDocument('Patient instructions');
      const translationNodes = [];
      const originalWalker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = originalWalker.nextNode())) {
        const parent = node.parentElement;
        if (!parent || parent.closest("script, style, noscript, template, [hidden], [aria-hidden='true'], textarea, title, [data-translation-control], [data-no-translate]") || !node.nodeValue?.trim()) continue;
        const marker = clone.createElement('span');
        marker.id = `translation-text-${translationNodes.length}`;
        marker.textContent = node.nodeValue;
        clone.body.append(marker);
        translationNodes.push({id:marker.id,type:'text',originalNode:node});
      }
      if (translateValues) {
        const valueContainer = clone.createElement("div");
        valueContainer.id = "translation-values";
        valueContainer.style.cssText = "position:absolute;left:-10000px;top:0";
        for (const field of document.querySelectorAll("textarea[data-translate-value]")) {
          if (!field.value.trim()) continue;
          const marker = clone.createElement("span");
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
        html: `<!DOCTYPE html>\n${clone.documentElement.outerHTML}`,
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
        if (!node.parentElement?.closest("[data-translation-control], [data-no-translate]")) state.textNodes.push({ node, value: node.nodeValue });
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
      for (const item of translationNodes) {if (!translatedDocument.getElementById(item.id)) throw new Error('Translation is incomplete.');}
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

    }

    function restorePage() {
      document.dispatchEvent(new Event("patient-language-changing"));
      restoreOriginalPage(translatedItems);
      translatedItems = [];
      isTranslated = false;
      document.documentElement.lang = originalLanguage;
      document.documentElement.dir = originalDirection;
      translateButton.textContent = "Translate page";
      status.textContent = "Original page text restored.";
      setBusy(false);
    }

    let languagesLoaded = false;
    async function loadLanguages() {
      if (languagesLoaded) return;
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
        languagesLoaded = true;
        setBusy(false);
        status.textContent = `${result.languages.length} AWS Translate languages available.`;
      } catch (error) {
        status.textContent = error.message || "Available languages could not be loaded.";
      }
    }

    languageSelect.addEventListener("change", () => {if (isTranslated) restorePage();});
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
      translating = true;
      document.dispatchEvent(new Event("patient-language-changing"));
      const requestVersion = version;
      const originalState = captureOriginalPage();
      try {
        const translationDocument = createTranslationDocument();
        const cacheKey = targetLanguage + translationDocument.html;
        let result = translationCache.get(cacheKey);
        if (!result) {
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
        result = await readApiJson(response, "The translation endpoint");

        }
        if (typeof result.translatedHtml !== "string" || !result.translatedHtml.trim()) {
          throw new Error("AWS Translate returned an invalid HTML document.");
        }
        const translatedDocument = new DOMParser().parseFromString(result.translatedHtml, "text/html");
        if (!translatedDocument.documentElement || !translatedDocument.body) {
          throw new Error("AWS Translate returned an invalid HTML document.");
        }
        if (requestVersion !== version) return;
        document.dispatchEvent(new Event("patient-language-changing"));
        applyTranslatedDocument(translatedDocument, translationDocument.translationNodes);
        if (translationCache.size >= 20) translationCache.delete(translationCache.keys().next().value);
        translationCache.set(cacheKey,result);
        translatedItems = originalState;
        isTranslated = true;
        document.documentElement.lang = targetLanguage;
        document.documentElement.dir = ["ar", "he", "fa", "ur"].includes(targetLanguage.split("-")[0])
          ? "rtl"
          : "ltr";
        translateButton.textContent = "Show original";
        status.textContent = "Page translated. Verify clinical instructions before relying on them.";
      } catch (error) {
        if (requestVersion !== version) return;
        restoreOriginalPage(originalState);
        status.textContent = error.message || "The page could not be translated.";
      } finally {
        if (requestVersion === version) {translating = false; setBusy(false);}
      }
    });

    document.addEventListener('patient-content-changing', () => {
      version++;
      resumeTranslation = isTranslated || translating || resumeTranslation;
      translating = false;
      if (isTranslated) restorePage();
      setBusy(false);
    });
    document.addEventListener('patient-content-updated', () => {
      if (resumeTranslation) {resumeTranslation = false; translateButton.click();}
    });
    document.addEventListener('patient-translation-ready', () => {void loadLanguages();});
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeTranslation, { once: true });
  } else {
    initializeTranslation();
  }
})();
