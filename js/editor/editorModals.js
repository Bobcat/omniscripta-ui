import { ModalController } from "@spa-foundation/core";

export function setupHistoryModal({
    historyBtn,
    closeHistoryBtn,
    historyModal,
    player,
    clearSelection,
    detailsEl,
    renderHistory,
}) {
    const historyModalController = historyModal
        ? new ModalController(historyModal, {
            backdropEvent: 'mousedown',
            onBackdrop: () => closeHistoryModal()
        })
        : null;

    function openHistoryModal() {
        if (!historyModalController) return;
        try { player.pause(); } catch { }
        clearSelection();
        if (detailsEl) detailsEl.textContent = '(click an item)';
        historyModalController.open();
        renderHistory();
    }

    function closeHistoryModal() {
        if (!historyModalController) return;
        historyModalController.close();
    }

    if (historyBtn) historyBtn.addEventListener('click', openHistoryModal);
    if (closeHistoryBtn) closeHistoryBtn.addEventListener('click', closeHistoryModal);

    return { openHistoryModal, closeHistoryModal };
}

export function setupHelpModal({
    helpBtn,
    closeHelpBtn,
    helpModal,
    player,
}) {
    const helpModalController = helpModal
        ? new ModalController(helpModal, {
            backdropEvent: 'click',
            onBackdrop: () => closeHelpModal()
        })
        : null;

    function openHelpModal() {
        if (!helpModalController) return;
        try { player.pause(); } catch { }
        helpModalController.open();
        setTimeout(() => { closeHelpBtn?.focus?.(); }, 0);
    }

    function closeHelpModal() {
        if (!helpModalController) return;
        helpModalController.close();
    }

    if (helpBtn) helpBtn.addEventListener('click', openHelpModal);
    if (closeHelpBtn) closeHelpBtn.addEventListener('click', closeHelpModal);

    return { openHelpModal, closeHelpModal };
}

export function setupSettingsModal({
    settingsBtn,
    closeSettingsBtn,
    settingsModal,
    optKeepCentered,
    optAutoSplitTs,
    flushPendingText,
    player,
    resetSettingsDrag,
    onSettingsDragUp,
    loadSettings,
    saveSettings,
    getKeepCenteredDuringPlayback,
    setKeepCenteredDuringPlayback,
    getAutoAssignSplitTs,
    setAutoAssignSplitTs,
}) {
    function syncSettingsUI() {
        if (optKeepCentered) optKeepCentered.checked = !!getKeepCenteredDuringPlayback();
        if (optAutoSplitTs) optAutoSplitTs.checked = !!getAutoAssignSplitTs();
    }

    const settingsModalController = settingsModal
        ? new ModalController(settingsModal, {
            backdropEvent: 'mousedown',
            onBackdrop: () => closeSettingsModal()
        })
        : null;

    function openSettingsModal() {
        if (!settingsModalController) return;
        flushPendingText();
        try { player.pause(); } catch { }
        resetSettingsDrag();
        loadSettings();
        syncSettingsUI();
        settingsModalController.open();
    }

    function closeSettingsModal() {
        if (!settingsModalController) return;
        onSettingsDragUp();
        settingsModalController.close();
    }

    if (settingsBtn) settingsBtn.addEventListener('click', openSettingsModal);
    if (closeSettingsBtn) closeSettingsBtn.addEventListener('click', closeSettingsModal);

    if (optKeepCentered) {
        optKeepCentered.addEventListener('change', (e) => {
            setKeepCenteredDuringPlayback(!!e.target.checked);
            saveSettings();
        });
    }

    if (optAutoSplitTs) {
        optAutoSplitTs.addEventListener('change', (e) => {
            setAutoAssignSplitTs(!!e.target.checked);
            saveSettings();
        });
    }

    return { openSettingsModal, closeSettingsModal, syncSettingsUI };
}
