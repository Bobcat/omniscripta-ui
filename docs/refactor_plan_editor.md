# Refactor Plan: `js/editor.js` (microstappen)

## Doel
- `js/editor.js` kleiner en beter onderhoudbaar maken.
- Per stap alleen kleine, veilige extracties.
- Geen functionele veranderingen tijdens refactor.

## Werkwijze
- Maximaal kleine stapjes (ongeveer 30-80 regels verplaatsen per stap).
- Na elke stap een korte handmatige smoke-test.
- Bij mislukte test: stap direct terugdraaien.
- Geen verplichte commits per stap.

## Rollback zonder commits
Gebruik dit patroon per stap:

1. Voor de stap:
```bash
git stash push -u -m "pre-step-<n>"
```

2. Als de stap faalt:
```bash
git restore --source=stash@{0} -- .
```

3. Als de stap slaagt:
- stash laten staan als safety net, of later verwijderen:
```bash
git stash drop stash@{0}
```

## Module-doelbeeld
- `js/editor.js` -> alleen orchestratie (`mountEditor`, wiring, lifecycle).
- `js/editorHelpers.js` -> pure helpers.
- `js/editorDom.js` -> DOM refs/selectie.
- `js/editorSave.js` -> save/export (bestaat al).
- `js/editorFind.js` -> find/replace (bestaat al).
- `js/editorSegments.js` -> segment mutaties (bestaat al).
- Volgende extracties:
  - `editorPlayback.js`
  - `editorRender.js` (segment/text rendering)
  - `editorModals.js`
  - `editorFilters.js`
  - `editorShortcuts.js`

## Status
- [x] Microstap 1: pure helpers naar `js/editorHelpers.js`
- [x] Microstap 2: boot DOM refs naar `js/editorDom.js`
- [ ] Microstap 3: drag handlers (find/help/filter/settings) extractie
- [ ] Microstap 4: playback/time sync extractie
- [ ] Microstap 5: renderpaden extractie
- [ ] Microstap 6: filter state/apply extractie
- [ ] Microstap 7: modal wiring extractie
- [ ] Microstap 8: shortcuts extractie
- [ ] Microstap 9: cleanup orchestrator

## Handmatige testchecklists

### Basis smoke test (na elke stap, 5-7 min)
1. Open `http://localhost:8080/index.html`.
2. Laad transcript + audio.
3. Speel audio af en pauzeer.
4. Wijzig 1 segmenttekst en 1 timestamp.
5. Open/sluit minstens 1 modal.
6. Controleer browser console op errors.

### Extra test voor playback-stappen (8-10 min)
1. Seek met player en controleer actieve segment highlight.
2. Test `Space`, pijltjes links/rechts.
3. Zet loop/repeat (als actief in huidige build) en controleer gedrag.

### Extra test voor filter/find-stappen (8-10 min)
1. Open Find/Replace en doe 1 find + 1 replace.
2. Zet filter op speaker of changed/done.
3. Verwijder filter en controleer herstel van zichtbare segmenten.

### Extra test voor save-stappen (5 min)
1. `Save` of `Save as`.
2. Heropen bestand en controleer dat wijzigingen aanwezig zijn.

## Definition of done
- `js/editor.js` is primair orchestratiebestand (richtwaarde: < 800 regels).
- Geen regressies in:
  - upload/open -> editor
  - edit + segmentacties
  - find/replace
  - save/export
  - playback + navigatie
- Geen cyclische imports.
