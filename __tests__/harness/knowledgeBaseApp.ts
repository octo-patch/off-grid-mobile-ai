/**
 * knowledgeBaseApp — a project's Knowledge Base screen mounted on a REAL navigation stack (a project page
 * that opens it, the knowledge base, and the document preview its rows open), over the REAL document
 * engine (harness/documentEngine). Tests drive it by gestures: pick files, flip a switch, remove a row,
 * open a row, go back.
 *
 * The test file must `jest.unmock('@react-navigation/native')` (top level, hoisted) so the real
 * navigation runs.
 *
 * Device leaves only: the document picker (the OS sheet) answers with the files the test seeded on the
 * memfs disk, the OS confirmation dialog (Alert) is answered by the test, and everything under
 * harness/documentEngine.
 */
import { installNativeBoundary, requireRTL, GB, type NativeBoundary } from './nativeBoundary';
import { installDocumentEngine, type DocumentEngineBoundary, type DocumentEngineOptions } from './documentEngine';

export interface PickedFile {
  /** Where the file sits on the device (seed it first). */
  path: string;
  name: string;
  size?: number;
}

export async function openKnowledgeBase(
  options: DocumentEngineOptions & { projectName?: string; beforeMount?: (engine: DocumentEngineBoundary) => void } = {},
) {
  const boundary: NativeBoundary = installNativeBoundary({
    fs: true,
    ram: { platform: 'ios', totalBytes: 8 * GB, availBytes: 6 * GB },
  });
  const engine = installDocumentEngine(boundary.fs!, options);
  const React = require('react');
  const rtl = requireRTL();
  const RN = require('react-native');
  const picker = require('@react-native-documents/picker');
  const { NavigationContainer } = require('@react-navigation/native');
  const { createNativeStackNavigator } = require('@react-navigation/native-stack');
  const { KnowledgeBaseScreen } = require('../../src/screens/KnowledgeBaseScreen');
  const { DocumentPreviewScreen } = require('../../src/screens/DocumentPreviewScreen');
  const { useProjectStore } = require('../../src/stores/projectStore');
  options.beforeMount?.(engine);

  // A knowledge base belongs to a project; the project is made with the store's own action.
  const project = useProjectStore.getState().createProject({
    name: options.projectName ?? 'Research',
    description: '',
    systemPrompt: '',
  });

  // The OS confirmation dialog: remember what it offered so the test can answer it like a person.
  let dialog: { title: string; message?: string; buttons: { text?: string; onPress?: () => void }[] } | null = null;
  RN.Alert.alert = (title: string, message?: string, buttons?: { text?: string; onPress?: () => void }[]) => {
    dialog = { title, message, buttons: buttons ?? [] };
  };

  const Stack = createNativeStackNavigator();
  const ProjectPage = ({ navigation }: { navigation: { navigate: (name: string, params: object) => void } }) =>
    React.createElement(
      RN.TouchableOpacity,
      { onPress: () => navigation.navigate('KnowledgeBase', { projectId: project.id }) },
      React.createElement(RN.Text, null, 'Open knowledge base'),
    );
  const view = rtl.render(
    React.createElement(
      NavigationContainer,
      null,
      React.createElement(
        Stack.Navigator,
        { screenOptions: { headerShown: false } },
        React.createElement(Stack.Screen, { name: 'ProjectDetail', component: ProjectPage }),
        React.createElement(Stack.Screen, { name: 'KnowledgeBase', component: KnowledgeBaseScreen }),
        React.createElement(Stack.Screen, { name: 'DocumentPreview', component: DocumentPreviewScreen }),
      ),
    ),
  );
  rtl.fireEvent.press(view.getByText('Open knowledge base'));
  await view.findByTestId('knowledge-base-screen');

  return {
    boundary,
    engine,
    rtl,
    view,
    project,
    /** The picker hands back these files (seeded on disk first), then the add button is tapped. */
    async addFiles(files: PickedFile[]) {
      picker.pick.mockResolvedValue(
        files.map(file => ({ uri: `file://${file.path}`, name: file.name, size: file.size ?? 0 })),
      );
      const empty = view.queryByText('Add Document');
      rtl.fireEvent.press(empty ?? view.getByLabelText('Add documents'));
      // Each file is either listed or named on the error card, and the add button works again.
      await rtl.waitFor(() =>
        expect(files.every(file => view.queryByText(file.name)) || view.queryByTestId('kb-index-error-card')).toBeTruthy(),
      );
      await rtl.waitFor(() =>
        expect(view.getByLabelText('Add documents').props.accessibilityState?.disabled).toBeFalsy(),
      );
    },
    /** The status line of a document's row ("12.0 KB · 3 pages"), found by the file it came from. */
    async statusOf(path: string) {
      return view.findByTestId(`knowledge-document-status-${await engine.documentIdOf(path)}`);
    },
    /** Answer the open OS dialog by tapping one of its buttons. */
    answerDialog(buttonText: string) {
      const open = dialog;
      if (!open) throw new Error('no dialog is open');
      dialog = null;
      const button = open.buttons.find(candidate => candidate.text === buttonText);
      if (!button) throw new Error(`the dialog "${open.title}" has no "${buttonText}" button`);
      return rtl.act(async () => {
        await button.onPress?.();
      });
    },
    dialogTitle: () => (dialog as { title: string } | null)?.title ?? null,
  };
}
