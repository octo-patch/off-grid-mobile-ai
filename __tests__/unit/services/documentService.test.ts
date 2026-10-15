/**
 * DocumentService Unit Tests
 *
 * Tests for which documents can be attached.
 * Priority: P1 - Document attachment support.
 */


// Mock pdfExtractor - must be defined inline due to Jest hoisting
jest.mock('../../../src/services/pdfExtractor', () => ({
  pdfExtractor: {
    isAvailable: jest.fn(() => false),
    extractText: jest.fn(),
  },
}));

import { documentService } from '../../../src/services/documentService';
import { pdfExtractor } from '../../../src/services/pdfExtractor';

const mockedPdfExtractor = pdfExtractor as jest.Mocked<typeof pdfExtractor>;

describe('DocumentService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset pdfExtractor mock to default (unavailable)
    mockedPdfExtractor.isAvailable.mockReturnValue(false);
    mockedPdfExtractor.extractText.mockReset();
  });

  // ========================================================================
  // isSupported
  // ========================================================================
  describe('isSupported', () => {
    it('returns true for .txt files', () => {
      expect(documentService.isSupported('readme.txt')).toBe(true);
    });

    it('returns true for .md files', () => {
      expect(documentService.isSupported('notes.md')).toBe(true);
    });

    it('returns true for .py files', () => {
      expect(documentService.isSupported('script.py')).toBe(true);
    });

    it('returns true for .ts files', () => {
      expect(documentService.isSupported('index.ts')).toBe(true);
    });

    it('returns true for .json files', () => {
      expect(documentService.isSupported('data.json')).toBe(true);
    });

    it('returns false for .pdf files when native module unavailable', () => {
      // PDFExtractorModule is not mocked, so isAvailable() returns false
      expect(documentService.isSupported('document.pdf')).toBe(false);
    });

    it('returns false for .docx files', () => {
      expect(documentService.isSupported('document.docx')).toBe(false);
    });

    it('returns false for .png files', () => {
      expect(documentService.isSupported('image.png')).toBe(false);
    });

    it('returns false for files with no extension', () => {
      expect(documentService.isSupported('Makefile')).toBe(false);
    });

    it('handles case-insensitive extensions', () => {
      expect(documentService.isSupported('README.TXT')).toBe(true);
      expect(documentService.isSupported('script.PY')).toBe(true);
    });
  });


  // ========================================================================
  // getSupportedExtensions
  // ========================================================================
  describe('getSupportedExtensions', () => {
    it('returns an array of supported extensions', () => {
      const extensions = documentService.getSupportedExtensions();

      expect(Array.isArray(extensions)).toBe(true);
      expect(extensions).toContain('.txt');
      expect(extensions).toContain('.md');
      expect(extensions).toContain('.py');
      expect(extensions).toContain('.ts');
    });

    it('does not include .pdf when native module is unavailable', () => {
      const extensions = documentService.getSupportedExtensions();
      expect(extensions).not.toContain('.pdf');
    });
  });

});
