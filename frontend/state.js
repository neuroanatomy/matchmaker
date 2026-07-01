export const state = {
    viewer: null, player: null, dataRoot: '',

    // ── Subject roster ────────────────────────────────────────────────────────
    subjects: {},          // { [id]: { id, path, sphere, sulc, curv, sulci, rot } }
    subjectOrder: [],      // IDs in insertion order
    activeSubjectId: null, // selected in Load / Preprocess / Align
    viewedSubjectId: null, // whose mesh is in the 3D viewer

    // viewState keyed by subject ID
    viewState: {},         // { [id]: { meshType: null|'native'|'sphere', texType: null|'sulc'|'curv' } }

    // ── Project state ─────────────────────────────────────────────────────────
    projectRoot: null,

    // ── Match step ────────────────────────────────────────────────────────────
    existingMatches: [],   // [{name, dir, mov_id, ref_id, has_morph, has_match, params}]
    matchRefId: null,
    matchMovId: null,
    matchOutDir: null,
    morphResult: null,
    matchResult: null,
    matchK: 100,
    matchNsteps: 1,
    matchWSmooth: 1.0,
    matchWDeform: 10.0,
    matchWProject: 1.0,
    matchViewMode: 'morph',
    matchViewOpacity: 0.6,
    morphSphereData: null,
    morphSurface: null,
    matchSurface: null,
    morphInterpT: 0,

    // ── View / Trajectory step ────────────────────────────────────────────────
    existingTrajectories: [],  // [{name, dir, n_frames, done, params}]
    trajSeq: [],               // ordered subject IDs oldest→youngest for new trajectory
    trajMode: 'raw',
    trajNDeformSmooth: 5,
    trajDoIcp: false,
    trajNTrajSmooth: 1,
    trajNSpatialSmooth: 1,
    trajLambdaSpatial: 0.005,
    loadedTrajDir: null,       // which trajectory is currently in the player

    // ── Align step ────────────────────────────────────────────────────────────
    alignSubjectId: null,
    alignInMemory: {},         // { [id]: overlayJSON }
    alignStereoView: null,
    alignOverlay: null,
    alignViewMode: 'flat',
    alignWireframe: false,
    alignHas3DOrientation: false,

    currentStep: 1,
};
