// Small helps on top of pages that already work without script.

// Choose a CSV file and it is read into the paste box, so the form posts it as text.
for (const input of document.querySelectorAll('[data-file-into]')) {
  input.addEventListener('change', async () => {
    const target = document.getElementById(input.dataset.fileInto);
    const [file] = input.files;
    if (target && file) target.value = await file.text();
  });
}

// "Copy listing text" for Marketplace and forums.
for (const button of document.querySelectorAll('[data-copy-button]')) {
  button.addEventListener('click', async () => {
    const box = button.parentElement.querySelector('[data-copy]');
    if (!box) return;
    try {
      await navigator.clipboard.writeText(box.value);
      button.textContent = 'Copied';
    } catch {
      box.select();
      button.textContent = 'Press Ctrl+C or ⌘C';
    }
  });
}
