// Replay-only source catalog: these exact official public pages were verified
// during this canary. No URL or personal detail comes from the meeting/model.
export const PRIMARY_RULE_PAGES=[
 ['IRS: termination of employment','https://www.irs.gov/retirement-plans/plan-participant-employee/retirement-topics-termination-of-employment'],
 ['Department of Labor: changing jobs and job loss','https://www.dol.gov/agencies/ebsa/workers-and-families/changing-jobs-and-job-loss']
];
export async function curatedRules(signal){
 const {fetchPublicArticle}=await import('../../server/lib/meeting-web-page.ts');
 const {publicAddress}=await import('../../server/lib/meeting-ask-web.ts');
 const pages=await Promise.all(PRIMARY_RULE_PAGES.map(async([title,url],i)=>{
  const page=await fetchPublicArticle(url,publicAddress,signal);
  return page?{id:`W${i+1}`,kind:'web',title:page.title||title,url:page.url,text:'Retrieved page excerpt (may be partial): '+page.text,retrievedAt:new Date().toISOString()}:null;
 }));
 return pages.filter(Boolean);
}
