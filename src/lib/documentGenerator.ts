import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } from 'docx';
import { saveAs } from 'file-saver';

export async function generateWordDocument(
  content: string, 
  fileName: string, 
  formData: Record<string, string>
): Promise<void> {
  try {
    // Parse the contract content and create structured document
    const lines = content.split('\n');
    const paragraphs: Paragraph[] = [];

    let isTitle = true;
    let currentSection = '';

    for (const line of lines) {
      const trimmedLine = line.trim();
      
      if (!trimmedLine) {
        // Add spacing for empty lines
        paragraphs.push(new Paragraph({
          children: [new TextRun("")],
          spacing: { after: 120 }
        }));
        continue;
      }

      // Title (first non-empty line)
      if (isTitle && trimmedLine) {
        paragraphs.push(new Paragraph({
          children: [
            new TextRun({
              text: trimmedLine,
              bold: true,
              size: 32
            })
          ],
          heading: HeadingLevel.TITLE,
          alignment: AlignmentType.CENTER,
          spacing: { after: 400 }
        }));
        isTitle = false;
        continue;
      }

      // Section headers (numbered sections like "1. ПРЕДМЕТ ДОГОВОРУ")
      if (/^\d+\.\s+[А-ЯІЇЄҐ\s]+$/.test(trimmedLine)) {
        paragraphs.push(new Paragraph({
          children: [
            new TextRun({
              text: trimmedLine,
              bold: true,
              size: 24
            })
          ],
          heading: HeadingLevel.HEADING_1,
          spacing: { before: 240, after: 120 }
        }));
        currentSection = trimmedLine;
        continue;
      }

      // Subsection headers (like "1.1. Орендодавець передає...")
      if (/^\d+\.\d+\.\s+/.test(trimmedLine)) {
        paragraphs.push(new Paragraph({
          children: [
            new TextRun({
              text: trimmedLine,
              size: 22
            })
          ],
          spacing: { before: 120, after: 60 }
        }));
        continue;
      }

      // Location and date line
      if (trimmedLine.includes('м. Київ') && /\d{2}\.\d{2}\.\d{4}/.test(trimmedLine)) {
        paragraphs.push(new Paragraph({
          children: [
            new TextRun({
              text: trimmedLine,
              size: 22
            })
          ],
          alignment: AlignmentType.JUSTIFIED,
          spacing: { after: 240 }
        }));
        continue;
      }

      // Signature lines
      if (trimmedLine.includes('_____________')) {
        const parts = trimmedLine.split('_____________');
        paragraphs.push(new Paragraph({
          children: [
            new TextRun({
              text: parts[0],
              size: 22
            }),
            new TextRun({
              text: "________________________",
              size: 22
            }),
            new TextRun({
              text: parts[1] || "",
              size: 22
            })
          ],
          spacing: { before: 240, after: 120 }
        }));
        continue;
      }

      // Regular paragraphs
      paragraphs.push(new Paragraph({
        children: [
          new TextRun({
            text: trimmedLine,
            size: 22
          })
        ],
        alignment: AlignmentType.JUSTIFIED,
        spacing: { after: 120 }
      }));
    }

    // Create the document
    const doc = new Document({
      sections: [{
        properties: {
          page: {
            margin: {
              top: 1440,    // 1 inch = 1440 twips
              right: 1440,
              bottom: 1440,
              left: 1440,
            },
          },
        },
        children: paragraphs,
      }],
    });

    // Generate and download the document
    const buffer = await Packer.toBuffer(doc);
    const blob = new Blob([buffer], { 
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' 
    });
    
    saveAs(blob, `${fileName}.docx`);
  } catch (error) {
    console.error('Error generating Word document:', error);
    throw error;
  }
}