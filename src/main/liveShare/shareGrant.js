// Live Share: what a person or an invitation gets, as plain bounded data.
//
// A grant is { projects, rights }: the shared projects it sees (the host
// window's project ids) and what it may do beyond watching them
// (src/shared/liveShareRights.js). Everything that comes from outside (a
// guest, a saved file, the window) goes through these before it is kept.
import { cleanRights } from '../../shared/liveShareRights'

// Projects shared at once (and so a guest's at most).
export const MAX_PROJECTS = 16

// Project ids (the host window's): valid ids, each once, at most `max`.
export const isProjectId = (id) => typeof id === 'string' && /^[\w-]{1,80}$/.test(id)
export const cleanProjectIds = (list, max = MAX_PROJECTS) => [...new Set((Array.isArray(list) ? list : []).filter(isProjectId))].slice(0, max)

// A name or a label as given ('' when none: the window says "A guest"),
// without what could make it read as something else: control characters,
// format characters (bidi overrides and isolates, zero-width ones, the
// byte-order mark...) and line or paragraph separators.
export const cleanName = (name) =>
  String(name || '')
    // eslint-disable-next-line no-control-regex -- control characters are what it removes
    .replace(/[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]/gu, '')
    .trim()
    .slice(0, 40)

export const cleanGrant = (grant, maxProjects = MAX_PROJECTS) => ({
  projects: cleanProjectIds(grant && grant.projects, maxProjects),
  rights: cleanRights(grant && grant.rights)
})

export const copyGrant = (grant) => ({ projects: [...grant.projects], rights: { ...grant.rights } })
