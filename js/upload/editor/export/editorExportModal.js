import { ModalController, createDialogDragController } from "@spa-foundation/core";
import { exportDocumentsLocally } from "./editorSave.js";

export function setupExportModal({
  flushPendingText,
  player,
  getExportContext,
  showToast,
}) {
  const exportDocBtn = document.getElementById('exportDocBtn');
  const exportModal = document.getElementById('exportModal');
  const exportCard = exportModal ? exportModal.querySelector('.export-card') : null;
  const exportDragHandle = document.getElementById('exportDragHandle');
  const cancelExportBtn = document.getElementById('cancelExportBtn');
  const downloadExportBtn = document.getElementById('downloadExportBtn');
  const exportFormatList = document.getElementById('exportFormatList');

  const exportDrag = createDialogDragController((x, y) => {
    if (exportCard) {
      exportCard.style.setProperty('--drag-x', `${x}px`);
      exportCard.style.setProperty('--drag-y', `${y}px`);
    }
  });

  function resetExportDrag() { exportDrag.reset(); }
  function onExportDragUp() { exportDrag.onUp(); }

  if (exportDragHandle) {
    exportDragHandle.addEventListener('mousedown', exportDrag.onMouseDown);
  }

  const exportModalController = exportModal
    ? new ModalController(exportModal, {
      backdropEvent: 'mousedown',
      onBackdrop: () => closeExportModal(),
    })
    : null;

  function getSelectedExportFormats() {
    if (!exportFormatList) return [];
    const checkboxes = exportFormatList.querySelectorAll('input[type="checkbox"]:not([disabled])');
    const selected = [];
    for (const cb of checkboxes) {
      if (cb.checked) selected.push(String(cb.value || '').trim().toLowerCase());
    }
    return selected;
  }

  function syncExportDownloadButton() {
    if (!downloadExportBtn) return;
    downloadExportBtn.disabled = getSelectedExportFormats().length === 0;
  }

  function openExportModal() {
    if (!exportModalController) return;
    flushPendingText();
    try { player.pause(); } catch { }
    resetExportDrag();
    syncExportDownloadButton();
    exportModalController.open();
  }

  function closeExportModal() {
    if (!exportModalController) return;
    onExportDragUp();
    exportModalController.close();
  }

  if (exportDocBtn) exportDocBtn.addEventListener('click', openExportModal);
  if (cancelExportBtn) cancelExportBtn.addEventListener('click', closeExportModal);
  if (exportFormatList) {
    exportFormatList.addEventListener('change', () => syncExportDownloadButton());
  }
  if (downloadExportBtn) {
    downloadExportBtn.addEventListener('click', async () => {
      const formats = getSelectedExportFormats();
      if (formats.length === 0) {
        showToast("Select at least one format");
        return;
      }
      try {
        const result = await exportDocumentsLocally(formats, getExportContext());
        if (result && result.archive) {
          showToast(`Downloaded: ${result.archiveName || "export.zip"}`);
        } else {
          const names = (result && Array.isArray(result.downloaded)) ? result.downloaded : [];
          showToast(`Downloaded: ${names[0] || "document"}`);
        }
        closeExportModal();
      } catch (e) {
        const msg = (e && e.message) ? e.message : "Export failed";
        showToast(msg);
      }
    });
  }

  return {
    exportModal,
    closeExportModal,
  };
}
