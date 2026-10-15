/**
 * DocumentPreviewScreen — what a person sees when they open a document: its pages as the phone read
 * them, opened from a chip, a knowledge-base row or a tapped citation.
 *
 * Mounted on a REAL navigation stack over the REAL document engine: documentService keeps the file, the
 * shared ingest service reads it into documents.db, and the screen shows the stored pages. Only native
 * leaves are stood in for (harness/documentEngine: memfs, in-memory SQLite, the PDF reader, the
 * embedding model).
 */
import { installNativeBoundary, requireRTL, GB } from '../../harness/nativeBoundary';
import { installDocumentEngine } from '../../harness/documentEngine';

jest.unmock('@react-navigation/native');

// The icon font is native; draw each icon as its name so the back arrow can be found and pressed.
jest.mock('react-native-vector-icons/Feather', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return ({ name }: { name: string }) => React.createElement(Text, null, name);
});

type PreviewParams = {
  filePath: string;
  fileName: string;
  fileSize: number;
  documentId?: string;
  page?: number;
};

function setup() {
  const boundary = installNativeBoundary({ fs: true, ram: { platform: 'ios', totalBytes: 8 * GB, availBytes: 6 * GB } });
  const engine = installDocumentEngine(boundary.fs!);
  const React = require('react');
  const rtl = requireRTL();
  const { Text, TouchableOpacity } = require('react-native');
  const { NavigationContainer } = require('@react-navigation/native');
  const { createNativeStackNavigator } = require('@react-navigation/native-stack');
  const { DocumentPreviewScreen } = require('../../../src/screens/DocumentPreviewScreen');
  const { documentService } = require('../../../src/services/documentService');
  const Stack = createNativeStackNavigator();

  /** The chat the preview was opened from, then the preview itself (navigated to, so Back has somewhere to go). */
  const open = (params: PreviewParams) => {
    const Chat = ({ navigation }: { navigation: { navigate: (name: string, p: PreviewParams) => void } }) =>
      React.createElement(
        TouchableOpacity,
        { onPress: () => navigation.navigate('DocumentPreview', params) },
        React.createElement(Text, null, 'Open document'),
      );
    const view = rtl.render(
      React.createElement(
        NavigationContainer,
        null,
        React.createElement(
          Stack.Navigator,
          { screenOptions: { headerShown: false } },
          React.createElement(Stack.Screen, { name: 'Chat', component: Chat }),
          React.createElement(Stack.Screen, { name: 'DocumentPreview', component: DocumentPreviewScreen }),
        ),
      ),
    );
    rtl.fireEvent.press(view.getByText('Open document'));
    return view;
  };
  return { boundary, engine, rtl, documentService, open };
}

describe('DocumentPreviewScreen', () => {
  describe('a document the phone has read', () => {
    it('shows its pages from the document index, under the file name', async () => {
      const h = setup();
      h.engine.seedPdf('/docs/Downloads/zenland.pdf', [
        'Zenland: an introduction.',
        'The capital of Zenland is Quixotic City.',
        'Bananas grow in the south.',
      ]);
      const attachment = await h.documentService.attachDocument('/docs/Downloads/zenland.pdf', 'zenland.pdf');

      const view = h.open({ filePath: '', fileName: 'zenland.pdf', fileSize: 0, documentId: attachment.documentId, page: 2 });

      // The loader shows while the stored pages are fetched (it announces itself as "Working").
      expect(view.getByLabelText('Working')).toBeTruthy();
      await h.rtl.waitFor(() => expect(view.getByText('The capital of Zenland is Quixotic City.')).toBeTruthy());
      expect(view.getByText('zenland.pdf')).toBeTruthy();
      expect(view.getByText('Page 1')).toBeTruthy();
      expect(view.getByText('Page 2')).toBeTruthy();
      expect(view.queryByLabelText('Working')).toBeNull();
    });

    it('says so when the document could not be read', async () => {
      const h = setup();
      // Damaged: the native reader cannot open it.
      h.engine.seedText('/docs/Downloads/broken.pdf', 'not really a pdf');
      const attachment = await h.documentService.attachDocument('/docs/Downloads/broken.pdf', 'broken.pdf');

      const view = h.open({ filePath: '', fileName: 'broken.pdf', fileSize: 0, documentId: attachment.documentId });

      await h.rtl.waitFor(() => expect(view.getByText('Could not read this document.')).toBeTruthy());
    });

    it.each([
      ['an empty text file', (h: ReturnType<typeof setup>) => h.engine.seedText('/docs/Downloads/doc.txt', ''), 'doc.txt'],
      ['a scanned PDF with no text layer', (h: ReturnType<typeof setup>) => h.engine.seedPdf('/docs/Downloads/doc.pdf', ['', '']), 'doc.pdf'],
    ])('shows no content for %s, instead of saying it is still being read', async (_label, seed, name) => {
      const h = setup();
      seed(h);
      const attachment = await h.documentService.attachDocument(`/docs/Downloads/${name}`, name);

      const view = h.open({ filePath: '', fileName: name, fileSize: 0, documentId: attachment.documentId });

      // Reading finished and found no text: waiting would never help, so the screen must not ask the person to.
      await h.rtl.waitFor(() => expect(view.getByText('No content available')).toBeTruthy());
      expect(view.queryByText(/still being read/)).toBeNull();
    });
  });

  describe('a file opened by its path (an attachment from before documents were indexed)', () => {
    it('reads the file and shows its text verbatim, with the size in the header', async () => {
      const h = setup();
      h.engine.seedText('/docs/data.json', '{"a": [1, 2], "b": "<tag>"}');

      const view = h.open({ filePath: '/docs/data.json', fileName: 'data.json', fileSize: 1024 });

      await h.rtl.waitFor(() => expect(view.getByText('{"a": [1, 2], "b": "<tag>"}')).toBeTruthy());
      expect(view.getByText('1.0 KB')).toBeTruthy();
    });

    it('finds a file whose path is URL-encoded', async () => {
      const h = setup();
      h.engine.seedText('/docs/my notes.txt', 'Decoded path body');

      const view = h.open({ filePath: 'file:///docs/my%20notes.txt', fileName: 'my notes.txt', fileSize: 17 });

      await h.rtl.waitFor(() => expect(view.getByText('Decoded path body')).toBeTruthy());
    });

    it('finds the file in Documents under its name without the picker\'s UUID prefix (after a reinstall)', async () => {
      const h = setup();
      h.engine.seedText('/docs/report.txt', 'Report body');

      const view = h.open({
        filePath: '/old-install/Documents/0c7d6f6a-1b2c-4d5e-8f90-123456789abc-report.txt',
        fileName: '0c7d6f6a-1b2c-4d5e-8f90-123456789abc-report.txt',
        fileSize: 11,
      });

      await h.rtl.waitFor(() => expect(view.getByText('Report body')).toBeTruthy());
    });

    it('explains when the file is gone', async () => {
      const h = setup();

      const view = h.open({ filePath: '/old-install/Documents/gone.txt', fileName: 'gone.txt', fileSize: 10 });

      await h.rtl.waitFor(() => expect(view.getByText(/File not found/)).toBeTruthy());
    });
  });

  it('goes back to where it was opened from', async () => {
    const h = setup();
    h.engine.seedText('/docs/notes.txt', 'Some notes');
    const view = h.open({ filePath: '/docs/notes.txt', fileName: 'notes.txt', fileSize: 10 });
    await h.rtl.waitFor(() => expect(view.getByText('Some notes')).toBeTruthy());

    h.rtl.fireEvent.press(view.getByText('arrow-left'));

    await h.rtl.waitFor(() => expect(view.queryByText('Some notes')).toBeNull());
    expect(view.getByText('Open document')).toBeTruthy();
  });
});
