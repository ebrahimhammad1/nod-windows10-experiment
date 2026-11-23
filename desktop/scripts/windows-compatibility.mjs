// Experimental Windows 10 build option, added November 23, 2026.
// This changes installer admission only. It does not certify runtime compatibility.
export function windowsCompatibilityBuild(env = process.env) {
  const value = env.NOD_EXPERIMENTAL_WINDOWS10;
  if (value !== undefined && value !== '' && value !== 'true' && value !== 'false') {
    throw new Error('NOD_EXPERIMENTAL_WINDOWS10 must be true or false.');
  }
  if (value !== 'true') return [];
  if (env.NOD_RELEASE_BUILD === 'true') {
    throw new Error('Experimental Windows 10 builds cannot be official release builds.');
  }
  return ['/DNOD_EXPERIMENTAL_WINDOWS10'];
}
