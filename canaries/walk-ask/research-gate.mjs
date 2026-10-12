// A fetched page is a necessary condition for this fact-check canary, not proof
// of relevance, truth, authority, or claim-level citation support.
export function fetchedPages(sources){return sources.filter(s=>s.kind==='web' && /^https?:\/\//.test(s.url??'') && s.text?.startsWith('Retrieved page excerpt') && s.text.length>200);}
export function pageGroundedCitation(answer,sources){
 const cited=new Set([...((answer?.answer??'')+' '+(answer?.reason??'')).matchAll(/\[([TWH]\d+)\]/g)].map(m=>m[1]));
 return fetchedPages(sources).some(s=>cited.has(s.id));
}
