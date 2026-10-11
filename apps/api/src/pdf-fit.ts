import { PDFDocument, degrees } from 'pdf-lib';
import { paperPoints, type PaperSize } from '@qr-print/shared';
export type FitOptions = { paperSize:PaperSize; orientation:'AUTO'|'PORTRAIT'|'LANDSCAPE'; marginPt?:number };
export async function fitPdf(bytes:Uint8Array, options:FitOptions) {
  const source = await PDFDocument.load(bytes,{ignoreEncryption:false});
  const output = await PDFDocument.create();
  const [baseW,baseH] = paperPoints[options.paperSize];
  const margin = Math.max(0,Math.min(options.marginPt ?? 18,baseW/4,baseH/4));
  const pages = [];
  for (const original of source.getPages()) {
    const {width,height} = original.getSize();
    const landscape = options.orientation === 'LANDSCAPE' || (options.orientation === 'AUTO' && width > height);
    const [pageW,pageH] = landscape ? [baseH,baseW] : [baseW,baseH];
    const embedded = await output.embedPage(original);
    const rotated = (original.getRotation().angle % 180) !== 0;
    const contentW = rotated ? height : width, contentH = rotated ? width : height;
    const scale = Math.min((pageW-2*margin)/contentW,(pageH-2*margin)/contentH);
    const drawW = contentW*scale, drawH = contentH*scale;
    const x=(pageW-drawW)/2, y=(pageH-drawH)/2;
    const page=output.addPage([pageW,pageH]);
    page.drawPage(embedded,{x,y,width:drawW,height:drawH,rotate:degrees(original.getRotation().angle)});
    pages.push({width:pageW,height:pageH,scale,x,y,orientation:landscape?'LANDSCAPE':'PORTRAIT'});
  }
  return {pdf:await output.save(),pageCount:pages.length,pages};
}
