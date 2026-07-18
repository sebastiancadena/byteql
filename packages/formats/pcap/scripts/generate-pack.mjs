// Placeholder for the pcap dissect-registry/query-pack generator.
//
// The MIDI pack's equivalent script reads `midi.tables.yaml` + `queries.yaml`
// and emits `src/*.generated.ts`. pcap's counterparts (`pcap.tables.yaml`,
// the dissect registry described in PRD Appendix A / `network/PROVENANCE.md`)
// do not exist yet — they land in a later Phase 1 slice task. Until then this
// script is a deliberate no-op so `pnpm build` / `check` / `test` (which all
// chain through `generate:pack`) keep working for the parts of the pack that
// do exist (Kaitai compilation).
