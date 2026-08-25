import PreferencesForm from "@/components/preferences-form";
import ReplayTourButton from "@/components/onboarding/replay-button";

export default function PreferencesPage() {
  return (
    <section>
      <h2 className="text-lg font-semibold">Preferences</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Customize how MixOS looks and behaves for you.
      </p>
      <div className="mt-4">
        <PreferencesForm />
      </div>
      <ReplayTourButton />
    </section>
  );
}
