import java.io.File;
import java.security.KeyStore;

/**
 * Prints the name of the environment variable whose value unlocks the release key.
 *
 * The Android Gradle plugin reads the key with KeyStore.getKey(alias, keyPassword),
 * and that is the check that failed. keytool cannot stand in for it: on a PKCS12
 * store (keytool's default since JDK 9) it ignores -keypass entirely, and the key's
 * password is the store password whatever -keypass said at generation time. So the
 * same call is made here, with each candidate, and nothing but a name is printed —
 * the passwords themselves only ever live in the environment.
 *
 *   java AndroidKeyPassword.java <keystore> <aliasVar> <storePassVar> <candidateVar>...
 */
public class AndroidKeyPassword {
  public static void main(String[] args) throws Exception {
    String alias = System.getenv(args[1]);
    char[] storePass = System.getenv(args[2]).toCharArray();
    KeyStore store = KeyStore.getInstance(new File(args[0]), storePass);
    if (!store.containsAlias(alias)) {
      System.err.println("The keystore has no entry for the configured alias.");
      System.exit(1);
    }
    for (int i = 3; i < args.length; i++) {
      String value = System.getenv(args[i]);
      if (value == null || value.isEmpty()) continue;
      try {
        if (store.getKey(alias, value.toCharArray()) != null) {
          System.out.println(args[i]);
          return;
        }
      } catch (Exception wrongPassword) {
        // Try the next candidate.
      }
    }
    System.err.println("None of the configured passwords unlocks the release key.");
    System.exit(1);
  }
}
