export function setupHistoryModal({
    historyBtn,
    closeHistoryBtn,
    historyModal,
    player,
    clearSelection,
    detailsEl,
    renderHistory,
}) {
    function openHistoryModal() {
        if (!historyModal) return;
        try { player.pause(); } catch { }
        try { clearSelection(); } catch { }
        if (detailsEl) detailsEl.textContent = '(click an item)';
        historyModal.classList.remove('hidden');
        try { renderHistory(); } catch { }
    }

    function closeHistoryModal() {
        if (!historyModal) return;
        historyModal.classList.add('hidden');
    }

    if (historyBtn) historyBtn.addEventListener('click', openHistoryModal);
    if (closeHistoryBtn) closeHistoryBtn.addEventListener('click', closeHistoryModal);
    if (historyModal) {
        historyModal.addEventListener('mousedown', (e) => {
            if (e.target === historyModal) closeHistoryModal();
        });
    }

    return { openHistoryModal, closeHistoryModal };
}

export function setupHelpModal({
    helpBtn,
    closeHelpBtn,
    helpModal,
    player,
}) {
    function openHelpModal() {
        if (!helpModal) return;
        try { player.pause(); } catch { }
        helpModal.classList.remove('hidden');
        setTimeout(() => { closeHelpBtn?.focus?.(); }, 0);
    }

    function closeHelpModal() {
        if (!helpModal) return;
        helpModal.classList.add('hidden');
    }

    if (helpBtn) helpBtn.addEventListener('click', openHelpModal);
    if (closeHelpBtn) closeHelpBtn.addEventListener('click', closeHelpModal);
    if (helpModal) {
        helpModal.addEventListener('click', (e) => {
            if (e.target === helpModal) closeHelpModal();
        });
    }

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

    function openSettingsModal() {
        flushPendingText();
        try { player.pause(); } catch { }
        try { resetSettingsDrag(); } catch { }
        try { loadSettings(); } catch { }
        syncSettingsUI();
        if (settingsModal) settingsModal.classList.remove('hidden');
    }

    function closeSettingsModal() {
        try { onSettingsDragUp(); } catch { }
        if (settingsModal) settingsModal.classList.add('hidden');
    }

    if (settingsBtn) settingsBtn.addEventListener('click', openSettingsModal);
    if (closeSettingsBtn) closeSettingsBtn.addEventListener('click', closeSettingsModal);
    if (settingsModal) {
        settingsModal.addEventListener('mousedown', (e) => {
            if (e.target === settingsModal) closeSettingsModal();
        });
    }

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
