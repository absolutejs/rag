import {expect,test} from 'bun:test';
import {readRAGWebsite,readRAGWebpage} from '../src/web';
import {selectResearchExcerpts} from '../src/research/sourceExcerpts';
const text='General company information and navigation. '.repeat(1500)+' Annual membership pricing is USD 975 per month. Exceptions apply to franchise operators.';
const fetchResource=async(url:string)=>({url,status:200,headers:{'content-type':'text/html'},body:new TextEncoder().encode(`<main>${text}</main>`)});
test('page previews retain complete source including facts beyond the old 12k and 24k cutoffs',async()=>{
 const page=await readRAGWebpage({url:'https://example.com',fetchResource,maxChars:1000});
 expect(page.text.length).toBeLessThanOrEqual(1000);
 expect(page.truncated).toBe(true);
 expect(page.fullText).toContain('USD 975 per month');
 expect(page.originalChars).toBe(page.fullText!.length);
});
test('website documents retain full sources even when preview budget is exhausted',async()=>{
 const site=await readRAGWebsite({url:'https://example.com',fetchResource,maxChars:1000,maxPages:1});
 expect(site.documents[0]?.text.length).toBeLessThanOrEqual(1000);
 expect(site.documents[0]?.fullText).toContain('Exceptions apply to franchise operators');
 expect(site.documents[0]?.sourceTruncated).toBe(false);
 expect(site.coverage.incompleteReads).toEqual([]);
});
test('bounded model context can select pricing at the end without deleting source text',()=>{
 const excerpts=selectResearchExcerpts(text,2000,'annual membership pricing franchise exceptions');
 expect(excerpts.join('\n')).toContain('USD 975 per month');
 expect(excerpts.reduce((sum,item)=>sum+item.length,0)).toBeLessThanOrEqual(2000);
 for(const excerpt of excerpts)expect(text.includes(excerpt)).toBe(true);
});
