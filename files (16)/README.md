# OBCHÓD — planer tras kontrolnych stacji paliw

Narzędzie pomaga planiście ułożyć trasy delegacji dla zespołów kontrolnych:
na podstawie comiesięcznej tabeli ryzyk proponuje, które stacje odwiedzić
i w jakiej kolejności, żeby pogodzić priorytet kontroli z sensowną geografią.

Zastępuje ręczne wyszukiwanie stacji na mapie i dobieranie ich „po drodze".

---

## Spis treści

1. [Jak uruchomić](#jak-uruchomić)
2. [Jak używać](#jak-używać)
3. [Pliki projektu](#pliki-projektu)
4. [Konfiguracja](#konfiguracja)
5. [Aktualizacja bazy stacji](#aktualizacja-bazy-stacji)
6. [Testowanie zmian](#testowanie-zmian)
7. [Edycja kodu w Notatniku](#edycja-kodu-w-notatniku)
8. [Jak działa dobór tras](#jak-działa-dobór-tras)
9. [Znane ograniczenia](#znane-ograniczenia)
10. [Rozwiązywanie problemów](#rozwiązywanie-problemów)

---

## Jak uruchomić

Nie trzeba niczego instalować. Wszystkie pliki muszą leżeć w jednym katalogu.

1. Kliknij dwukrotnie `index.html`.
2. Aplikacja otworzy się w przeglądarce.

Wymagany jest **dostęp do internetu** — mapa, odczyt Excela i liczenie tras
korzystają z usług zewnętrznych (szczegóły w [Znanych ograniczeniach](#znane-ograniczenia)).

---

## Jak używać

**1. Wczytaj tabelę ryzyk.** W lewym panelu kliknij „Wybierz plik(i)" i wskaż
miesięcznego Excela. Pojawi się okno mapowania kolumn — przy każdej kolumnie
wybierz, co zawiera. Kluczowe są dwie: **Nr stacji** i **Waga / ranking ryzyka**.

Zaznacz też, w którą stronę idzie ranking:
- *Wyższe wartości = wyższy priorytet* — gdy większa liczba oznacza pilniejszą kontrolę,
- *Niższe wartości = wyższy priorytet* — gdy plik jest listą rankingową i pozycja 1 jest najpilniejsza.

**Można wybrać kilka plików naraz w jednym oknie** (Ctrl/Cmd + klik) — np.
osobno CODO i osobno DOFO, jeśli tak wygląda Twoja praca. Zostają wczytane
razem, jedną wspólną mapą kolumn; zakładamy, że mają tę samą strukturę
(ta sama kolumna numeru stacji, ta sama kolumna wagi w obu). Można też
wczytywać pliki **po kolei**, osobnymi kliknięciami „Wybierz plik" — działa
tak samo: drugi (i kolejny) import **dopisuje się** do pierwszego, dotyka
tylko stacji, które są w nim wymienione, i zostawia wagi oraz zapisane trasy
z poprzednich importów bez zmian. Jeśli ten sam numer stacji pojawi się
w dwóch plikach, wygrywa ten wczytany później.

> **Pliki różnej długości nie zaburzają priorytetów.** Ranking z każdego
> pliku jest normalizowany do wspólnej skali *względem pozycji w tym pliku*
> (najpilniejsza stacja w pliku = szczyt skali, niezależnie ile plik ma
> wierszy) — dzięki temu plik CODO na 1200 stacji i plik DOFO na 450 stacji
> są ze sobą bezpośrednio porównywalne. „Najpilniejsza w DOFO" nie przegrywa
> już z „451. w CODO" tylko dlatego, że plik CODO jest dłuższy.

**2. Ustaw zespoły.** Podaj liczbę kontrolerów, a następnie dla każdego wpisz
nazwisko i wybierz **punkt startowy** (Warszawa / Gdańsk / Nowa Wieś Wielka).
Każdy kontroler planuje własną, osobną trasę.

Stacja trafia do kontrolera tylko wtedy, gdy jego baza jest jej **naprawdę
najbliższym** punktem startowym — spośród wszystkich trzech skonfigurowanych, nie tylko
tych obsadzonych w tym konkretnym budowaniu. Dzięki temu kontroler z Gdańska
nie dostanie stacji spod Warszawy tylko dlatego, że akurat nikt inny dziś nie
planuje z Warszawy — takie stacje zostają pominięte, a status po budowaniu
powie wprost ile i dlaczego.

Jeśli mimo to chcesz, żeby dany kontroler pokrył szerszy obszar (np. zastępuje
kogoś, albo faktycznie ma jechać dalej) — zaznacz przy nim **„Szukaj w całym
kraju"**. Wtedy ten kontroler bierze pod uwagę stacje z całej Polski, nie
tylko te przypisane do jego punktu startowego terytorialnie.

Jeśli z jednej bazy jedzie kilka osób, jej stacje dzielone są między nie.

> Wspólne trasy dla kilku osób (np. dojazd z dwóch różnych baz do wspólnego
> punktu zbiórki) nie są obecnie obsługiwane — funkcja była testowana, ale
> nie działała wystarczająco niezawodnie i została wycofana do czasu, aż
> będzie gotowa. Każdy kontroler planuje osobno.

**2b. Wybierz tryb parametrów budowy tras.** Pod polem „Wlicz powrót do punktu startowego"
są dwa tryby:

- **Tryb prosty** (domyślny) — parametry zaszyte na stałe: kontrola 120 min,
  warianty 1/2/3-dniowe, budżet dnia 8 godz, twardy limit 11 godz, przerwa
  60 min, próg wielodniowy 100 km. Zachowanie identyczne jak dotychczas.
- **Tryb rozszerzony** — odsłania te same wartości jako edytowalne pola:
  czas kontroli stacji, warianty długości delegacji do wygenerowania (można
  odznaczyć np. wariant 3-dniowy, żeby przyspieszyć liczenie), budżet dnia,
  twardy limit dnia, przerwę, próg km dla delegacji wielodniowych, oraz
  **grupę stacji do przeszukania** (Wszystkie / tylko CODO / tylko DOFO) —
  przydatne, gdy akurat planujesz wyłącznie jedną sieć. Przycisk
  „Przywróć wartości domyślne" cofa wszystko do trybu prostego bez jego
  przełączania. Nieprawidłowa wartość (spoza zakresu albo pusta) jest
  cicho zastępowana wartością domyślną tego pola, a pod polami pojawia się
  krótki komunikat, co zostało poprawione.

> Tryb i wartości są ustawieniem roboczym sesji — jak liczba kontrolerów czy
> punkt startowy, **nie zapisują się** w projekcie ani w przeglądarce. Po
> odświeżeniu strony aplikacja wraca do trybu prostego.
>
> Reguły dnia pracy w trybie rozszerzonym to wciąż te same **niepotwierdzone
> założenia** opisane w [Konfiguracji](#konfiguracja) — tryb rozszerzony
> ułatwia ich testowanie, ale nie zastępuje weryfikacji z działem kadr
> i prawnym przed użyciem produkcyjnym.

**2c. Albo wskaż stacje ręcznie i uzupełnij resztę automatycznie.** Czasem
wiesz z góry, że konkretna stacja musi się znaleźć w trasie — niezależnie od
tego, jaką ma wagę w pliku ryzyka, czy w ogóle ją ma. Wyszukaj ją po numerze
lub nazwie w polu „Szukaj po numerze lub nazwie stacji" po lewej i kliknij
przycisk **⭐** przy niej — działa to **zawsze**, nie tylko przy otwartej
trasie.

Wybrana stacja trafia do nowej sekcji „Ręcznie wybrane stacje". Możesz dodać
więcej niż jedną. Jeśli masz wpisanego więcej niż jednego kontrolera, pojawi
się selektor **„Dla kogo"** — wybierasz, dla kogo ma powstać trasa, bez
potrzeby usuwania pozostałych z formularza. Kliknij **„Uzupełnij trasę"**:
aplikacja buduje trasę tylko dla wskazanego kontrolera, gwarantując, że
wybrane stacje się w niej znajdą, i dobiera resztę miejsc automatycznie —
tak samo jak przy zwykłym budowaniu (wg wagi, terytorium bazy, wybranego
filtru grupy).

> **Wybranie stacji ręcznie to świadome zezwolenie na wyjątek od terytorium**
> — jeśli wskażesz stację, która normalnie należałaby do innej bazy (patrz
> wyżej), i tak trafi do trasy tego kontrolera, bez potrzeby zaznaczania
> „Szukaj w całym kraju". Dotyczy tylko tej jednej, wskazanej stacji — reszta
> trasy nadal respektuje terytorium normalnie.
>
> Ta gwarancja jest **twarda**, nie tylko preferencją: silnik normalnie dobiera
> stacje wg wagi ryzyka, a ręcznie wybrana stacja zwykle ma wagę 0 (właśnie
> dlatego trzeba ją wybrać ręcznie — inaczej trafiłaby do automatu sama) i bez
> specjalnego oznaczenia przegrałaby konkurencję z każdą ważoną stacją. Silnik
> traktuje ją jako punkt startowy trasy, nie jako jednego z wielu kandydatów.

Wynik pojawia się w tym samym panelu propozycji co zwykłe budowanie — wybierz
wariant długości i zatwierdź tak samo jak zawsze.

**3. Zbuduj trasy.** Kliknij „Zbuduj trasy". Po prawej pojawia się **osobna
karta dla każdego kontrolera**, a nie jeden wspólny wariant na wszystkich —
każda karta ma przyciski z długościami delegacji, które faktycznie wyszły
wykonalne dla tej osoby (np. „2 dni" / „3 dni"), z liczbą stacji i czasem.
Kliknij wariant, żeby go wybrać dla danej osoby — **niezależnie od tego, co
wybrałeś dla pozostałych**. Domyślnie zaznaczony jest wariant z największą
liczbą pokrytych stacji, ale możesz to zmienić dla każdego z osobna.

**Każde kliknięcie wariantu od razu pokazuje go na mapie** (przerywana linia —
to podgląd na podstawie prostych odcinków, nie rzeczywista trasa drogowa z
OSRM, żeby działało błyskawicznie bez czekania na serwer). Dzięki temu widzisz,
co realnie wybierasz, zanim to zatwierdzisz — nie wybierasz w ciemno.

**Nie podoba Ci się zaproponowany zestaw stacji?** Kliknij **„↻ Zaproponuj
inny wariant"** pod propozycjami — wyklucza aktualnie pokazane stacje
i przelicza wszystko od nowa. Silnik jest deterministyczny (te same dane
zawsze dają ten sam wynik), więc to jedyny sposób na realnie inną trasę
bez ręcznej zmiany parametrów. Można kliknąć kilka razy z rzędu — wykluczenia
się kumulują, więc każda kolejna próba sięga po coraz dalsze kandydatki.
Zwykłe „Zbuduj trasy" (albo zatwierdzenie) zawsze zaczyna od zera, bez
wykluczeń z poprzednich prób.

Gdy wszyscy mają wybrany pasujący wariant, kliknij **„Zatwierdź wybrane
trasy"** — zapisuje jednym ruchem to, co wybrałeś dla każdej osoby.

> Silnik trasowania to heurystyka (kilka niezależnych prób + lokalna
> poprawa), nie dowiedziony matematycznie optimum — dla realnej liczby stacji
> znalezienie *idealnej* trasy zajęłoby zbyt długo. W praktyce wyniki są
> bliskie najlepszym możliwym, ale jeśli coś wygląda nieoptymalnie, zawsze
> możesz to poprawić ręcznie (patrz punkt 4 niżej).

**4. Popraw plan, jeśli trzeba.** Każdy dzień to osobna, wyraźnie obramowana
karta — od razu widać, które przystanki należą do którego dnia, zamiast
domyślać się z cienkiego nagłówka w jednej długiej liście.

**Przenoszenie między dniami — przeciągnij i upuść.** Złap przystanek za
uchwyt (⋮⋮ po lewej) i przeciągnij go do innej karty dnia:
- upuszczony **na konkretnym przystanku** — wstawia się tuż przed nim,
- upuszczony **gdziekolwiek indziej na karcie** — trafia na koniec tego dnia.

**Strzałki ▲▼ porządkują tylko w obrębie tego samego dnia** — nigdy nie
przeskakują do innego dnia same z siebie (to była główna przyczyna
zamieszania w poprzedniej wersji). Są wyszarzone i nieaktywne dokładnie
tam, gdzie i tak nie miałyby czego zrobić (pierwszy/ostatni przystanek dnia).
Zmiana dnia to zawsze przeciągnięcie — jeden, przewidywalny sposób na jedną
rzecz, zamiast dwóch nakładających się na siebie.

**✕** usuwa stację z trasy i zwalnia ją. Wolną stację z listy po lewej
dodasz do otwartej trasy przyciskiem **+** (albo dwuklikiem na wyszarzonej
pinezce na mapie) — trafia na koniec ostatniego dnia.

**Liczba dni trasy nie jest sztywna.** Nad listą kart są przyciski
**„+ dzień"** i **„− dzień"** — działają zawsze, niezależnie od tego, jaki
wariant wybrano przy budowaniu. Dodajesz dzień, gdy ręcznie dorzucone stacje
przekroczą limit czasu (zamiast tylko dostać ostrzeżenie bez wyjścia) — nowy
dzień jest pustą kartą z podpowiedzią, przeciągnij na nią przystanek z innego
dnia. Usunięcie dnia działa tylko wtedy, gdy jest pusty.

Po każdej zmianie czasy przejazdu są przeliczane. Przy nagłówku dnia widać
jego obciążenie; jeśli zmiana wypchnie dzień ponad limit 11 godzin, pojawi się
czerwone ostrzeżenie z podpowiedzią, żeby dodać dzień.

**5. Odhacz kontrole i wyślij kontrolerowi.** Przycisk ✓ przy stacji oznacza ją
jako skontrolowaną — **to ma teraz realne znaczenie**: skontrolowana stacja
(a) nie wraca automatycznie przy kolejnym „Zbuduj trasy" (znika z puli, dopóki
sam jej nie odznaczysz albo ręcznie nie dodasz), (b) świeci się na mapie na
**zielono**, niezależnie od grupy CODO/DOFO — także wśród wyszarzonych stacji
do ręcznego dodawania, żeby od razu było widać „to już jest zrobione, nie
dokładaj". Oznaczenie przeżywa usunięcie stacji z trasy, skasowanie całej
trasy i ponowny import pliku ryzyk (to trwała wiedza o stacji, nie stan tylko
na czas jednej trasy czy jednego importu) — resetuje się dopiero przy ręcznym
odznaczeniu albo ręcznym dodaniu tej stacji z powrotem do trasy.

**„Wygeneruj e-mail do kontrolera"** otwiera okno z gotową, czytelną treścią
wiadomości (baza, dni, stacje z adresami, czasy dojazdu i kontroli, powrót)
i przyciskiem „Kopiuj do schowka" — wklejasz od razu w e-mail albo komunikator.

**Filtr kontrolera w nagłówku.** Obok listy „wybierz trasę" jest drugi selektor
— wybierz osobę, a lista tras obok zawęzi się do tylko jej tras (wszystkich,
niezależnie kiedy powstały — daty widać wprost w nazwach opcji). Przydatne,
gdy masz wielu kontrolerów i szukasz konkretnej trasy bez przewijania pełnej
listy. Filtr pojawia się dopiero po zatwierdzeniu pierwszej trasy w projekcie.

**Zarządzaj trasami** (ikona listy z checkami w nagłówku) otwiera okno ze
wszystkimi zapisanymi trasami do zaznaczenia — „Usuń zaznaczone" kasuje tylko
wybrane (albo wszystkie naraz, jeśli zaznaczysz „Zaznacz wszystkie"), zwalniając
ich stacje z powrotem do puli wolnych. **Wgrany plik ryzyka i nadane wagi
zostają nietknięte** — to inne niż „Nowy projekt", które czyści wszystko od
zera, łącznie z importem.

**„Tylko trasa"** (przycisk nad mapą, obok „Czysta mapa") ukrywa wszystkie
stacje spoza aktywnej trasy — zostaje sama trasa, bez tła prawie 2000 innych
pinezek. Szybki przełącznik, stan nie zapisuje się w projekcie.

**Zapis pracy.** Stan zapisuje się automatycznie w przeglądarce. Ikona dyskietki
eksportuje projekt do pliku `.json` — używaj jej przed większymi zmianami
i do przenoszenia pracy na inny komputer.

---

## Pliki projektu

| Plik | Zawartość | Czy edytować |
|---|---|---|
| `index.html` | struktura strony | rzadko |
| `styles.css` | wygląd | tak, przy zmianach wizualnych |
| `script.js` | logika aplikacji, stan, interfejs | tak |
| `route-engine.js` | algorytm doboru tras i reguły czasu pracy | ostrożnie |
| `stations-db.js` | baza stacji (1954 pozycje) | **nie ręcznie** — patrz niżej |
| `test.html` | strona kontrolna | przy dodawaniu testów |
| `README.md` | ten plik | tak |

`script.js` i `route-engine.js` mają na górze spis sekcji, a każda sekcja
własny baner — szukaj linii z `====`.

---

## Konfiguracja

Prawie wszystko, co warto zmieniać, siedzi w obiekcie `CONFIG` na początku
`script.js` (sekcja 1).

### Dodanie kolejnej bazy

```js
BASES: [
  { id: 'waw', name: 'Warszawa', lat: 52.2297, lng: 21.0122 },
  { id: 'gda', name: 'Gdańsk',   lat: 54.3520, lng: 18.6466 },
  { id: 'nww', name: 'Nowa Wieś Wielka', lat: 52.9703, lng: 18.0914 }
  // dopisz tutaj kolejny wiersz
],
```

Współrzędne odczytasz z Map Google: prawy przycisk myszy na punkcie, pierwsza
pozycja w menu to szerokość i długość geograficzna. `id` musi być unikalne
i bez spacji.

### Pozostałe ustawienia

| Ustawienie | Znaczenie | Wartość |
|---|---|---|
| `AUDIT_MIN` | czas jednej kontroli w minutach | 120 |
| `PLAN_DAY_OPTIONS` | generowane warianty długości delegacji | `[1, 2, 3]` |
| `MAX_STATIONS_PER_AUDITOR` | wstępny limit stacji na kontrolera (przed podziałem na bazy) | 80 |
| `MAX_STATIONS_TOTAL` | limit stacji na jedno planowanie (przed podziałem na bazy) | 300 |
| `MAX_STATIONS_PER_OSRM_REQUEST` | twardy limit stacji na JEDNĄ bazę — patrz niżej | 95 |
| `OSRM_URL` | serwer liczący trasy | publiczny serwer demo |
| `NOMINATIM_URL` | serwer zamieniający adresy na współrzędne | publiczny serwer demo |
| `GEOCODE_DELAY_MS` | odstęp między zapytaniami o adresy | 1100 |

> **`MAX_STATIONS_PER_OSRM_REQUEST` — zmierzony limit, nie szacunek.**
> Publiczny `router.project-osrm.org` przyjmuje maksymalnie **100 punktów**
> w jednym zapytaniu `/table` (101 już odrzuca błędem `"Too many table
> coordinates"`) — potwierdzone bezpośrednim testem. `MAX_STATIONS_PER_AUDITOR`
> i `MAX_STATIONS_TOTAL` ograniczają tylko całą pulę stacji PRZED podziałem
> na bazy — same w sobie nie chronią przed tym limitem, jeśli większość
> stacji wypadnie geograficznie bliżej jednej bazy niż innych. Ten limit
> działa dopiero PO podziale, osobno dla każdej bazy, i realnie wymusza
> pominięcie nadmiarowych stacji (najniższego priorytetu) — planista zobaczy
> to w komunikacie po budowaniu planu.

> `GEOCODE_DELAY_MS` **nie powinno spaść poniżej 1000**. Regulamin Nominatim
> dopuszcza jedno zapytanie na sekundę; szybsze odpytywanie grozi zablokowaniem
> adresu IP firmy przez OpenStreetMap.

### Reguły czasu pracy

Siedzą w `route-engine.js`, w sekcji „STAŁE — REGUŁY DELEGACJI":

| Stała | Znaczenie | Wartość |
|---|---|---|
| `BASE_DAY_MIN` | budżet czasu na jeden dzień | 8 godz |
| `MAX_DAY_MIN` | twardy limit dobowy | 11 godz |
| `BREAK_MIN` | przerwa doliczana do dnia z aktywnością | 60 min |
| `MULTIDAY_MIN_KM_FROM_BASE` | próg odległości dla delegacji wielodniowych | 100 km |

Próg 100 km oznacza, że do delegacji 2- i 3-dniowych **nie trafiają stacje
bliżej niż 100 km od bazy** — nocleg dla stacji „za rogiem" nie ma uzasadnienia
kosztowego. Dla planu jednodniowego próg nie obowiązuje.

> **Te wartości nie zostały potwierdzone z działem kadr ani prawnym.**
> Przed produkcyjnym użyciem trzeba je zweryfikować — patrz [Znane ograniczenia](#znane-ograniczenia).
>
> Te same wartości (plus `AUDIT_MIN` i `PLAN_DAY_OPTIONS` z `script.js`) można
> teraz też dostosować bez edycji kodu — w panelu „Parametry trasy" przełącz
> na **tryb rozszerzony** (patrz [Jak używać](#jak-używać)). Zmiana w kodzie
> zmienia wartości domyślne (tryb prosty i punkt startowy trybu rozszerzonego);
> zmiana w UI dotyczy tylko bieżącej sesji.

---

## Aktualizacja bazy stacji

`stations-db.js` jest **generowany**, nie pisany ręcznie. Zawiera tablicę:

```js
window.STATIONS_DB = [
  { id: 'PL_CODO_1', group: 'PL_CODO', stationNo: '1', name: '...', lat: 52.1, lng: 21.0, city: 'Warszawa' },
  ...
];
```

`city` jest opcjonalne — jego brak nie psuje niczego (po prostu miasto nie
pokaże się przy stacji), ale jeśli jest, aplikacja pokazuje je obok stacji
w liście, propozycjach (dymek na mapie), zatwierdzonej trasie i w treści
generowanego e-maila do kontrolera.

Po regeneracji z nowego Excela **stara praca nie ginie**. Przy starcie aplikacja
scala zapisany stan z bazą według zasady:

- **baza decyduje** o nazwie, współrzędnych, mieście i grupie,
- **zapisany stan decyduje** o wadze ryzyka, przypisaniu do trasy i statusie kontroli.

Stacja usunięta z bazy jest zachowywana, jeśli ma nadaną wagę albo należy do
trasy — inaczej trasa straciłaby przystanek. Stacje dodane ręcznie przez import
adresowy (bez numeru stacji) są zachowywane zawsze.

Po każdej regeneracji **uruchom `test.html`** — sprawdzi, czy wszystkie stacje
mają poprawne współrzędne, czy leżą w granicach Polski i czy numery się nie
powtarzają. To wychwyci typowe błędy konwersji z Excela.

---

## Testowanie zmian

Otwórz `test.html` (podwójne kliknięcie). Strona sama przeprowadzi 78 testów
i pokaże zielony albo czerwony pasek.

**Rób to po każdej zmianie w `.js`, zanim otworzysz `index.html`.**

Testy obejmują: integralność bazy stacji, scalanie z zapisanym stanem,
odczyt danych z Excela, reguły czasu pracy, budowę tras, próg 100 km,
podział między kontrolerów i przydział stacji do baz.

Jeśli testów jest znacznie mniej niż 78, w którymś pliku `.js` jest błąd
składni — naciśnij **F12** i sprawdź zakładkę **Console**.

---

## Edycja kodu w Notatniku

**Kodowanie.** W oknie „Zapisz jako" pilnuj, żeby pole *Kodowanie* pokazywało
**UTF-8**. Zapis jako ANSI rozsypie polskie znaki i aplikacja przestanie działać.

**Podgląd błędów.** W przeglądarce **F12** → zakładka **Console** pokazuje
błędy składni z numerem linii. To zastępuje debugger.

**Nawiasy.** Notatnik ich nie sprawdza, a to najczęstsza przyczyna awarii.
Po edycji zawsze odpal `test.html`.

**Odświeżanie.** Przeglądarka cachuje pliki. Po zmianie naciśnij **Ctrl+F5**.
Jeśli to nie pomoże, w `index.html` podnieś numer przy nazwie pliku:
`script.js?v=2.0` → `script.js?v=2.1`.

**Zawijanie wierszy.** W Notatniku: *Widok → Zawijanie wierszy* — bez tego
długie linie uciekają poza ekran.

---

## Jak działa dobór tras

1. **Przydział do baz** — każda stacja trafia do najbliższej bazy spośród
   używanych; stacje jednej bazy dzielone są między jej kontrolerów.
2. **Klastrowanie** — podział uwzględnia geografię i wyrównanie obciążenia,
   żeby jeden kontroler nie dostał wszystkiego.
3. **Macierz odległości** — serwer OSRM zwraca rzeczywiste czasy przejazdu
   między wszystkimi punktami (nie odległości w linii prostej).
4. **Budowa trasy** — algorytm startuje od stacji o najwyższym ryzyku i dokłada
   kolejne, wybierając te o najlepszym stosunku priorytetu do kosztu objazdu,
   dopóki harmonogram mieści się w limicie dni.
5. **Dopracowanie** — metoda 2-opt odwraca fragmenty trasy, szukając krótszej
   kolejności przy tym samym zestawie stacji.

Powrót do punktu startowego doliczany jest **tylko do ostatniego dnia** — kontrolerzy nocują
tam, gdzie dojadą, i wracają na koniec delegacji.

Spośród podziałów na dni mieszczących się w limitach silnik wybiera ten
o **najbardziej wyrównanym obciążeniu** (najmniejszym odchyleniu między
dniami) — a nie taki, który ściska wszystko w pierwsze dni i zostawia
kolejne puste. Gdy stacji starcza na każdy dzień wariantu (np. 6+ stacji przy
3 dniach), silnik **zawsze wykorzysta wszystkie zamówione dni** — pusty dzień
przy wystarczającej liczbie stacji jest wprost odrzucany jako niepoprawny
wynik, nie tylko rzadziej wybierany.

**Gdy stacji jest mniej niż zażądanych dni**, silnik nie doklejа pustego dnia
na koniec — realnie wykorzystuje tylko tyle dni, ile ma sensu (np. 2 stacje
przy zażądanym wariancie 3-dniowym dają trasę 2-dniową, nie 3-dniową z pustym
dniem 3). Jeśli to sprawia, że dwa zażądane warianty (np. 2 i 3 dni) dają
identyczny wynik, propozycje pokażą go tylko raz, pod poprawną etykietą —
zamiast dwóch pozornie różnych, a faktycznie takich samych kart.

---

## Znane ograniczenia

**Publiczne serwery demonstracyjne.** Trasy liczy `router.project-osrm.org`,
a adresy zamienia `nominatim.openstreetmap.org`. Oba są serwerami demo bez
gwarancji dostępności i nieprzeznaczonymi do pracy produkcyjnej. Oznacza to też,
że **współrzędne stacji opuszczają sieć firmową**. Do pilotażu u jednego planisty
zwykle akceptowalne; przy szerszym użyciu wymaga decyzji IT o własnej instancji.

**Reguły czasu pracy niezwalidowane.** Limity dnia, przerwa i czas kontroli to
przyjęte założenia, nie potwierdzone przepisy. Wymagają weryfikacji z osobą
odpowiedzialną za delegacje przed produkcyjnym użyciem. Tryb rozszerzony
(patrz [Jak używać](#jak-używać)) pozwala je testować bez zmiany kodu, ale
nie zastępuje tej weryfikacji.

**Dane tylko w przeglądarce.** Stan trzymany jest w `localStorage` jednego
komputera. Nie ma wspólnej pracy zespołowej, historii zmian ani kopii zapasowej —
wyczyszczenie danych przeglądarki kasuje pracę. Zabezpieczenie: regularny eksport
projektu do `.json`.

**Zależność od CDN.** Leaflet, SheetJS i fonty ładują się z internetu. Jeśli
firmowa sieć blokuje `unpkg.com` lub `fonts.googleapis.com`, aplikacja nie wstanie.

**Brak wspólnych tras dla kilku osób.** Funkcja pozwalająca dwóm kontrolerom
jechać razem (w tym z dwóch różnych baz przez wspólny punkt zbiórki) była
zaimplementowana i przetestowana, ale okazała się zawodna w praktyce (błędy
przy budowaniu tras w niektórych konfiguracjach) i została wycofana przed
oddaniem aplikacji do użytku. Każdy kontroler planuje obecnie osobną trasę.
Warto do tego wrócić w przyszłości, ale porządnie — z większym zapasem
czasu na testy niż tym razem.

**E-mail bez konkretnych dat kalendarzowych.** Wiadomość generowana przyciskiem
„Wygeneruj e-mail do kontrolera" opisuje dni jako „Dzień 1", „Dzień 2" itd. —
aplikacja nie przypisuje trasom rzeczywistych dat, więc planista musi dopisać
je ręcznie przy wklejaniu (albo w temacie, albo bezpośrednio w treści).

**Wyniki nieporównane z planem ręcznym.** Nikt dotąd nie zestawił tras
z aplikacji z tymi, które planista układa sam. Bez takiego porównania nie wiadomo,
o ile narzędzie faktycznie skraca pracę.

---

## Rozwiązywanie problemów

**Mapa się nie ładuje / strona jest pusta.**
Sprawdź połączenie z internetem, potem **F12 → Console**. Jeśli widnieją tam
błędy ładowania `unpkg.com`, firmowa sieć blokuje CDN — to trzeba zgłosić IT.

**„Nie udało się wygenerować planu".**
Najczęstsza przyczyna: wszystkie stacje leżą bliżej niż 100 km od bazy, więc
odpadają z wariantów wielodniowych. Wariant 1-dniowy powinien się wygenerować.

**Import nie dopasował żadnej stacji.**
Sprawdź, czy kolumna z numerem stacji została oznaczona jako „Nr stacji"
i czy numery odpowiadają tym z bazy. Lista niedopasowanych numerów trafia
do konsoli (**F12**).

**Trasa nie chce się przeliczyć po edycji.**
Pojawia się ostrzeżenie „czasy mogą być nieaktualne" — to znaczy, że serwer
OSRM nie odpowiedział. Kolejność jest zapisana, ale czasy pochodzą sprzed zmiany.
Ponów edycję, gdy połączenie wróci.

**Aplikacja zachowuje się dziwnie po aktualizacji plików.**
Naciśnij **Ctrl+F5**. Jeśli nie pomoże, podnieś numer wersji przy nazwach
plików w `index.html`.

**Chcę zacząć od zera.**
Ikona nowego dokumentu w prawym górnym rogu kasuje cały zapisany stan
(baza stacji zostaje).
