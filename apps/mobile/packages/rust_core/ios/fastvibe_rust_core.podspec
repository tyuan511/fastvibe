Pod::Spec.new do |s|
  s.name = 'fastvibe_rust_core'
  s.version = '0.5.13'
  s.summary = 'FastVibe shared Rust mobile runtime'
  s.description = 'Links the same account, iroh and App Protocol runtime used by both Flutter platforms.'
  s.homepage = 'https://github.com/tyuan511/fastvibe'
  s.license = { :type => 'Apache-2.0', :file => '../LICENSE' }
  s.author = { 'FastVibe' => 'dev@fastvibe.dev' }
  s.source = { :path => '.' }
  s.platform = :ios, '15.0'
  s.dependency 'Flutter'
  s.vendored_frameworks = 'Frameworks/FastVibeMobileCore.xcframework'
  s.static_framework = true
  s.frameworks = 'Security', 'SystemConfiguration', 'Network'
  s.libraries = 'resolv', 'iconv', 'c++'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }

  # Dart resolves these symbols from the process. There is no Objective-C/Swift
  # reference to pull the Rust FFI object out of its static archive, and Release
  # dead stripping must not turn a successful build into a missing-symbol crash.
  symbols = %w[
    fv_mobile_core_version fv_mobile_core_create fv_mobile_core_destroy
    fv_mobile_core_free fv_mobile_core_command_json fv_mobile_core_command
    fv_mobile_core_poll_json fv_mobile_core_poll fv_mobile_core_apply_json
    fv_mobile_core_free_string
  ]
  s.user_target_xcconfig = {
    'OTHER_LDFLAGS' => '$(inherited) ' + symbols.map { |symbol| "-Wl,-u,_#{symbol}" }.join(' ')
  }
end
