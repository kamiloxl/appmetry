import { NativeModule, requireOptionalNativeModule } from 'expo';

// Native install-attribution module. Methods are added in Task 17.
// `null` when the native module is not linked (Expo Go, web, tests).
declare class AppdashAttributionModule extends NativeModule<{}> {}

export default requireOptionalNativeModule<AppdashAttributionModule>('AppdashAttribution');
