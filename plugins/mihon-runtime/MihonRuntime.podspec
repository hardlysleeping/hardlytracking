Pod::Spec.new do |s|
  s.name             = 'MihonRuntime'
  s.version          = '0.1.0'
  s.summary          = 'The on-device Mihon extension runtime for the HardlyTracking iOS shell.'
  s.description      = <<-DESC
Runs the M-Extension-Server in this process on an embedded OpenJDK Zero interpreter, and serves the
same /dalvik protocol on a loopback port. The app talks to it exactly as it talks to any other
extension host, so nothing above DalvikClient knows the runtime is local.
                       DESC
  s.homepage         = 'https://github.com/hardlysleeping/hardlytracking'
  s.license          = { :type => 'Proprietary' }
  s.author           = { 'HardlyTracking' => 'noreply@hardlysleep.ing' }
  s.source           = { :path => '.' }
  s.platform         = :ios, '15.0'

  # The podspec lives at the package root with the sources in `ios/`, because that is the shape
  # `cap sync` expects: it writes `pod 'MihonRuntime', :path => '…/plugins/mihon-runtime'` itself,
  # deriving the pod name from the package name, and resolves the spec from the package root.
  s.source_files        = 'ios/Classes/**/*.{h,mm,swift}'
  s.public_header_files = 'ios/Classes/MihonRuntime.h'
  s.dependency 'Capacitor'

  # Downloads and verifies the pinned JVM + server jar, then links the device slice. Runs on the Mac
  # that builds the app; there is no iOS SDK on the workstation, so this never runs there.
  s.prepare_command      = 'sh ios/PrepareEmbeddedRuntime.sh'
  s.vendored_frameworks  = 'ios/Frameworks/OpenJDKRuntime.xcframework'
  s.resource_bundles     = {
    'MihonRuntime_runtime' => ['ios/Runtime/**/*'],
    'MihonRuntime_notices' => ['ios/THIRD_PARTY_NOTICES.md'],
  }
  s.preserve_paths       = 'ios/RuntimeSources/**/*', 'ios/PrepareEmbeddedRuntime.sh', 'ios/THIRD_PARTY_NOTICES.md'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'CLANG_CXX_LANGUAGE_STANDARD' => 'gnu++20',
    # jni.h lives in the framework's headers, which only exist for the device slice.
    'HEADER_SEARCH_PATHS[sdk=iphoneos*]' =>
      '$(inherited) "$(PODS_TARGET_SRCROOT)/ios/Frameworks/OpenJDKRuntime.xcframework/ios-arm64/OpenJDKRuntime.framework/Headers"',
    'EXCLUDED_ARCHS[sdk=iphonesimulator*]' => 'i386',
  }
  s.swift_version = '5.0'
end
