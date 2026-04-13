import { forwardRef, useCallback, useEffect, useMemo, useRef } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import type { TextInputProps } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { getOverlayRoot, OVERLAY_Z } from "../lib/overlay-root";
import {
  BottomSheetModal,
  BottomSheetBackdrop,
  BottomSheetScrollView,
  BottomSheetTextInput,
  type BottomSheetBackgroundProps,
} from "@gorhom/bottom-sheet";
import { X } from "lucide-react-native";
import { FileDropZone } from "@/components/file-drop-zone";
import type { ImageAttachment } from "@/components/message-input";
import { isWeb } from "@/constants/platform";

const styles = StyleSheet.create((theme) => ({
  desktopOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "center",
    alignItems: "center",
    padding: theme.spacing[6],
    zIndex: OVERLAY_Z.modal,
    pointerEvents: "auto" as const,
  },
  desktopCard: {
    width: "100%",
    maxWidth: 520,
    maxHeight: "85%",
    flexShrink: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.xl,
    borderWidth: 1,
    borderColor: theme.colors.surface2,
  },
  header: {
    paddingHorizontal: theme.spacing[6],
    paddingVertical: theme.spacing[4],
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.surface2,
    gap: theme.spacing[3],
  },
  headerTitleGroup: {
    flex: 1,
    gap: theme.spacing[2],
    minWidth: 0,
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
  },
  closeButton: {
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface2,
  },
  desktopScroll: {
    flexShrink: 1,
    minHeight: 0,
  },
  desktopContent: {
    padding: theme.spacing[6],
    gap: theme.spacing[4],
    flexGrow: 1,
  },
  bottomSheetHandle: {
    backgroundColor: theme.colors.surface2,
  },
  bottomSheetHeader: {
    paddingHorizontal: theme.spacing[6],
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[3],
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.surface2,
    gap: theme.spacing[3],
  },
  bottomSheetContent: {
    padding: theme.spacing[6],
    gap: theme.spacing[4],
  },
}));

function SheetBackground({ style }: BottomSheetBackgroundProps) {
  const { theme } = useUnistyles();
  return (
    <View
      style={[
        style,
        {
          backgroundColor: theme.colors.surface1,
          borderTopLeftRadius: theme.borderRadius.xl,
          borderTopRightRadius: theme.borderRadius.xl,
        },
      ]}
    />
  );
}

export interface AdaptiveModalSheetProps {
  title: string;
  /** Optional content rendered below the title in the header area. */
  subtitle?: ReactNode;
  visible: boolean;
  onClose: () => void;
  children: ReactNode;
  snapPoints?: string[];
  stackBehavior?: "push" | "switch" | "replace";
  testID?: string;
  /** Override the max width of the desktop card. */
  desktopMaxWidth?: number;
  /** When provided, wraps the card content in a FileDropZone. */
  onFilesDropped?: (files: ImageAttachment[]) => void;
}

export function AdaptiveModalSheet({
  title,
  subtitle,
  visible,
  onClose,
  children,
  snapPoints,
  stackBehavior,
  testID,
  desktopMaxWidth,
  onFilesDropped,
}: AdaptiveModalSheetProps) {
  const { theme } = useUnistyles();
  const isMobile = useIsCompactFormFactor();
  const sheetRef = useRef<BottomSheetModal>(null);
  const dismissingForVisibilityRef = useRef(false);
  const resolvedSnapPoints = useMemo(() => snapPoints ?? ["65%", "90%"], [snapPoints]);

  useEffect(() => {
    if (isMobile || !visible || !isWeb || typeof window === "undefined") return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    // Capture phase: RN Web TextInput stops propagation, so bubbling listeners never fire.
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [isMobile, visible, onClose]);

  useEffect(() => {
    if (!isMobile) return;
    if (visible) {
      dismissingForVisibilityRef.current = false;
      sheetRef.current?.present();
    } else {
      dismissingForVisibilityRef.current = true;
      sheetRef.current?.dismiss();
    }
  }, [visible, isMobile]);

  const handleSheetChange = useCallback(
    (index: number) => {
      if (index === -1) {
        if (dismissingForVisibilityRef.current) {
          dismissingForVisibilityRef.current = false;
          return;
        }
        onClose();
      }
    },
    [onClose],
  );

  const renderBackdrop = useCallback(
    (props: React.ComponentProps<typeof BottomSheetBackdrop>) => (
      <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.45} />
    ),
    [],
  );

  if (isMobile) {
    return (
      <BottomSheetModal
        ref={sheetRef}
        snapPoints={resolvedSnapPoints}
        index={0}
        enableDynamicSizing={false}
        onChange={handleSheetChange}
        backdropComponent={renderBackdrop}
        enablePanDownToClose
        stackBehavior={stackBehavior}
        backgroundComponent={SheetBackground}
        handleIndicatorStyle={styles.bottomSheetHandle}
        keyboardBehavior="extend"
        keyboardBlurBehavior="restore"
      >
        <View style={styles.bottomSheetHeader}>
          <View style={styles.headerTitleGroup}>
            <Text style={styles.title}>{title}</Text>
            {subtitle}
          </View>
          <Pressable accessibilityLabel="Close" style={styles.closeButton} onPress={onClose}>
            <X size={16} color={theme.colors.foregroundMuted} />
          </Pressable>
        </View>
        <BottomSheetScrollView
          contentContainerStyle={styles.bottomSheetContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {children}
        </BottomSheetScrollView>
      </BottomSheetModal>
    );
  }

  const cardInner = (
    <>
      <View style={styles.header}>
        <View style={styles.headerTitleGroup}>
          <Text style={styles.title}>{title}</Text>
          {subtitle}
        </View>
        <Pressable accessibilityLabel="Close" style={styles.closeButton} onPress={onClose}>
          <X size={16} color={theme.colors.foregroundMuted} />
        </Pressable>
      </View>
      <ScrollView
        style={styles.desktopScroll}
        contentContainerStyle={styles.desktopContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {children}
      </ScrollView>
    </>
  );

  const desktopContent = (
    <View style={styles.desktopOverlay} testID={testID}>
      <Pressable
        accessibilityLabel="Dismiss"
        style={{ ...StyleSheet.absoluteFillObject }}
        onPress={onClose}
      />
      <View style={[styles.desktopCard, desktopMaxWidth != null && { maxWidth: desktopMaxWidth }]}>
        {onFilesDropped ? (
          <FileDropZone onFilesDropped={onFilesDropped}>{cardInner}</FileDropZone>
        ) : (
          cardInner
        )}
      </View>
    </View>
  );

  // On web, use portal to overlay root for consistent stacking with toasts
  if (isWeb && typeof document !== "undefined") {
    if (!visible) return null;
    return createPortal(desktopContent, getOverlayRoot());
  }

  return (
    <Modal
      transparent
      animationType="fade"
      visible={visible}
      onRequestClose={onClose}
      hardwareAccelerated
    >
      {desktopContent}
    </Modal>
  );
}

/**
 * TextInput that automatically uses BottomSheetTextInput on mobile
 * for proper keyboard dodging in AdaptiveModalSheet.
 */
export const AdaptiveTextInput = forwardRef<TextInput, TextInputProps>(
  function AdaptiveTextInput(props, ref) {
    const isMobile = useIsCompactFormFactor();

    if (isMobile) {
      return <BottomSheetTextInput ref={ref as any} {...props} />;
    }

    return <TextInput ref={ref} {...props} />;
  },
);
