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

    function collectPageText() {
      const items = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const parent = node.parentElement;
        if (!parent || parent.closest(
          "script, style, noscript, template, [hidden], [aria-hidden='true'], [data-translation-control]",
        )) continue;

        const original = node.nodeValue || "";
        const leadingWhitespace = original.match(/^\s*/u)?.[0] || "";
        const trailingWhitespace = original.match(/\s*$/u)?.[0] || "";
        const contentEnd = original.length - trailingWhitespace.length;
        const text = original.slice(leadingWhitespace.length, contentEnd);
        if (text) {
          items.push({
            node,
            property: "nodeValue",
            original,
            text: text,
            prefix: leadingWhitespace,
            suffix: trailingWhitespace,
          });
        }
      }

      const attributeNames = ["alt", "aria-description", "aria-label", "placeholder", "title"];
      for (const element of document.body.querySelectorAll(
        "input, textarea, button, a, img, iframe, [title], [aria-label], [aria-description]",
      )) {
        if (element.closest("[hidden], [aria-hidden='true'], [data-translation-control]")) continue;
        for (const attribute of attributeNames) {
          const value = element.getAttribute(attribute);
          if (value?.trim()) {
            items.push({ node: element, property: attribute, original: value, text: value });
          }
        }
        if (translateValues && element.hasAttribute("data-translate-value")
          && element instanceof HTMLTextAreaElement && element.value.trim()) {
          items.push({ node: element, property: "value", original: element.value, text: element.value });
        } else if (element instanceof HTMLInputElement
          && ["button", "reset", "submit"].includes(element.type) && element.value.trim()) {
          items.push({ node: element, property: "value", original: element.value, text: element.value });
        }
      }

      items.push({
        node: document,
        property: "title",
        original: document.title,
        text: document.title,
      });
      return items;
    }

    function restorePage() {
      for (const item of translatedItems) {
        if (item.property === "nodeValue") {
          item.node.nodeValue = item.original;
        } else if (item.node === document) {
          document.title = item.original;
        } else if (item.property === "value") {
          item.node.value = item.original;
        } else {
          item.node.setAttribute(item.property, item.original);
        }
      }
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
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Available languages could not be loaded.");
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

      const items = collectPageText();
      if (!items.length) {
        status.textContent = "There is no page text to translate.";
        return;
      }
      if (items.length > 250) {
        status.textContent = "This page has too much text to translate in one request.";
        return;
      }

      setBusy(true);
      status.textContent = "Translating page with AWS Translate…";
      try {
        const response = await fetch("/api/translate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            targetLanguage,
            texts: items.map((item) => item.text),
          }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "The page could not be translated.");
        if (!Array.isArray(result.translatedTexts)
          || result.translatedTexts.length !== items.length
          || result.translatedTexts.some((text) => typeof text !== "string")) {
          throw new Error("AWS Translate returned an invalid translation.");
        }

        items.forEach((item, index) => {
          const translatedText = result.translatedTexts[index];
          if (item.property === "nodeValue") {
            item.node.nodeValue = `${item.prefix}${translatedText}${item.suffix}`;
          } else if (item.node === document) {
            document.title = translatedText;
          } else if (item.property === "value") {
            item.node.value = translatedText;
          } else {
            item.node.setAttribute(item.property, translatedText);
          }
        });

        translatedItems = items;
        isTranslated = true;
        document.documentElement.lang = targetLanguage;
        document.documentElement.dir = ["ar", "he", "fa", "ur"].includes(targetLanguage.split("-")[0])
          ? "rtl"
          : "ltr";
        translateButton.textContent = "Show original";
        status.textContent = "Page translated. Verify clinical instructions before relying on them.";
      } catch (error) {
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
