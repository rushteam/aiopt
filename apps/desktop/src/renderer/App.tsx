export function App() {
  const { platform, versions } = window.hearth;
  return (
    <main
      style={{
        fontFamily: 'system-ui, sans-serif',
        display: 'grid',
        placeItems: 'center',
        height: '100vh',
        margin: 0,
      }}
    >
      <div style={{ textAlign: 'center' }}>
        <h1>Hearth</h1>
        <p>The security boundary is wired. Build your app inside it.</p>
        <p style={{ opacity: 0.6, fontSize: 13 }}>
          {platform} · Electron {versions.electron} · Chrome {versions.chrome}
        </p>
      </div>
    </main>
  );
}
