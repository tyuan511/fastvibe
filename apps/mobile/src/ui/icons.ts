import type { IconSvgElement } from "@hugeicons/react-native";

/**
 * Every icon the app draws, each from its own module.
 *
 * Never import from `@hugeicons/core-free-icons` itself: Metro does not tree-shake, so
 * the package index pulls in all ~6000 icons — 7.7 MB of source, over half of the JS
 * bundle, for the 30 used here. The per-icon files ship without type
 * declarations, which `hugeicons.d.ts` supplies.
 */
import Alert02IconSvg from "@hugeicons/core-free-icons/Alert02Icon";
import ArrowDown01IconSvg from "@hugeicons/core-free-icons/ArrowDown01Icon";
import ArrowRight01IconSvg from "@hugeicons/core-free-icons/ArrowRight01Icon";
import ArrowUp02IconSvg from "@hugeicons/core-free-icons/ArrowUp02Icon";
import BotIconSvg from "@hugeicons/core-free-icons/BotIcon";
import BrainIconSvg from "@hugeicons/core-free-icons/BrainIcon";
import Cancel01IconSvg from "@hugeicons/core-free-icons/Cancel01Icon";
import ChromeIconSvg from "@hugeicons/core-free-icons/ChromeIcon";
import Copy01IconSvg from "@hugeicons/core-free-icons/Copy01Icon";
import FileEditIconSvg from "@hugeicons/core-free-icons/FileEditIcon";
import FileMinusIconSvg from "@hugeicons/core-free-icons/FileMinusIcon";
import FilePlusIconSvg from "@hugeicons/core-free-icons/FilePlusIcon";
import FileTextIconSvg from "@hugeicons/core-free-icons/FileTextIcon";
import Folder01IconSvg from "@hugeicons/core-free-icons/Folder01Icon";
import FolderTreeIconSvg from "@hugeicons/core-free-icons/FolderTreeIcon";
import HandIconSvg from "@hugeicons/core-free-icons/HandIcon";
import ListChecksIconSvg from "@hugeicons/core-free-icons/ListChecksIcon";
import Loading03IconSvg from "@hugeicons/core-free-icons/Loading03Icon";
import MessageQuestionIconSvg from "@hugeicons/core-free-icons/MessageQuestionIcon";
import PlayIconSvg from "@hugeicons/core-free-icons/PlayIcon";
import Plug01IconSvg from "@hugeicons/core-free-icons/Plug01Icon";
import ScissorIconSvg from "@hugeicons/core-free-icons/ScissorIcon";
import Search01IconSvg from "@hugeicons/core-free-icons/Search01Icon";
import ShieldAlertIconSvg from "@hugeicons/core-free-icons/ShieldAlertIcon";
import ShieldCheckIconSvg from "@hugeicons/core-free-icons/ShieldCheckIcon";
import SparklesIconSvg from "@hugeicons/core-free-icons/SparklesIcon";
import SquareIconSvg from "@hugeicons/core-free-icons/SquareIcon";
import SquareTerminalIconSvg from "@hugeicons/core-free-icons/SquareTerminalIcon";
import Tick02IconSvg from "@hugeicons/core-free-icons/Tick02Icon";
import Wrench01IconSvg from "@hugeicons/core-free-icons/Wrench01Icon";

export const Alert02Icon: IconSvgElement = Alert02IconSvg;
export const ArrowDown01Icon: IconSvgElement = ArrowDown01IconSvg;
export const ArrowRight01Icon: IconSvgElement = ArrowRight01IconSvg;
export const ArrowUp02Icon: IconSvgElement = ArrowUp02IconSvg;
export const BotIcon: IconSvgElement = BotIconSvg;
export const BrainIcon: IconSvgElement = BrainIconSvg;
export const Cancel01Icon: IconSvgElement = Cancel01IconSvg;
export const ChromeIcon: IconSvgElement = ChromeIconSvg;
export const Copy01Icon: IconSvgElement = Copy01IconSvg;
export const FileEditIcon: IconSvgElement = FileEditIconSvg;
export const FileMinusIcon: IconSvgElement = FileMinusIconSvg;
export const FilePlusIcon: IconSvgElement = FilePlusIconSvg;
export const FileTextIcon: IconSvgElement = FileTextIconSvg;
export const Folder01Icon: IconSvgElement = Folder01IconSvg;
export const FolderTreeIcon: IconSvgElement = FolderTreeIconSvg;
export const HandIcon: IconSvgElement = HandIconSvg;
export const ListChecksIcon: IconSvgElement = ListChecksIconSvg;
export const Loading03Icon: IconSvgElement = Loading03IconSvg;
export const MessageQuestionIcon: IconSvgElement = MessageQuestionIconSvg;
export const PlayIcon: IconSvgElement = PlayIconSvg;
export const Plug01Icon: IconSvgElement = Plug01IconSvg;
export const ScissorIcon: IconSvgElement = ScissorIconSvg;
export const Search01Icon: IconSvgElement = Search01IconSvg;
export const ShieldAlertIcon: IconSvgElement = ShieldAlertIconSvg;
export const ShieldCheckIcon: IconSvgElement = ShieldCheckIconSvg;
export const SparklesIcon: IconSvgElement = SparklesIconSvg;
export const SquareIcon: IconSvgElement = SquareIconSvg;
export const SquareTerminalIcon: IconSvgElement = SquareTerminalIconSvg;
export const Tick02Icon: IconSvgElement = Tick02IconSvg;
export const Wrench01Icon: IconSvgElement = Wrench01IconSvg;
