#requires -Version 5.1
# Windows pilot: one cashier computer. Uses installed printer names, never changes drivers.
$ErrorActionPreference='Stop'
[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$script:Api='https://oplwrlljqwgxnrqrdufp.supabase.co/functions/v1/pos-api'
$script:StationApi='https://oplwrlljqwgxnrqrdufp.supabase.co/functions/v1/station-api'
$script:Token=$null
$script:Root=Join-Path $env:LOCALAPPDATA 'BakeBitePrintBridge'
New-Item -ItemType Directory -Force -Path $script:Root|Out-Null
$script:StatePath=Join-Path $script:Root 'state.json'
$script:ConfigPath=Join-Path $script:Root 'config.json'
$mutex=New-Object System.Threading.Mutex($false,'Local\BakeBitePrintBridge')
if(-not $mutex.WaitOne(0)){[Windows.Forms.MessageBox]::Show('Print Bridge เปิดอยู่แล้ว')|Out-Null;exit}
function Save-Json($Path,$Value){
    $temp=$Path+'.tmp'
    $Value|ConvertTo-Json -Depth 15|Set-Content -LiteralPath $temp -Encoding UTF8
    Move-Item -LiteralPath $temp -Destination $Path -Force
}
function Convert-ToMap($Value){
    if($null -eq $Value){return $null}
    if($Value -is [System.Management.Automation.PSCustomObject]){
        $map=@{};foreach($p in $Value.PSObject.Properties){$map[$p.Name]=Convert-ToMap $p.Value};return $map
    }
    if($Value -is [System.Array]){return ,@($Value|ForEach-Object{Convert-ToMap $_})}
    return $Value
}
function Get-JsonUtf8{
    param([string]$Uri,[string]$Method='Get',[hashtable]$Headers=@{},[byte[]]$Body)
    $options=@{Uri=$Uri;Method=$Method;Headers=$Headers;UseBasicParsing=$true;TimeoutSec=20}
    if($PSBoundParameters.ContainsKey('Body')){$options.Body=$Body;$options.ContentType='application/json; charset=utf-8'}
    $response=Invoke-WebRequest @options
    $stream=$response.RawContentStream
    if($stream.CanSeek){$stream.Position=0}
    $reader=New-Object System.IO.StreamReader($stream,[Text.Encoding]::UTF8,$true)
    try{$json=$reader.ReadToEnd();return ($json|ConvertFrom-Json)}finally{$reader.Dispose()}
}
function Api-Get([string]$Query){
    $r=Get-JsonUtf8 -Method Get -Uri ($script:Api+'?'+$Query) -Headers @{Authorization=('Bearer '+$script:Token)}
    if(-not $r.ok){throw 'API rejected request'};return $r
}
function Label-On($Form,[string]$Text,[int]$Y){
    $l=New-Object Windows.Forms.Label
    $l.Text=$Text;$l.Location=New-Object Drawing.Point(20,$Y);$l.Size=New-Object Drawing.Size(550,26)
    $Form.Controls.Add($l)
}
function Get-Login{
    $f=New-Object Windows.Forms.Form
    $f.Text='Bake & Bite Print Bridge - เข้าสู่ระบบ POS'
    $f.Size=New-Object Drawing.Size(490,310);$f.StartPosition='CenterScreen'
    $f.Font=New-Object Drawing.Font('Segoe UI',10)
    Label-On $f 'ใช้รหัส POS ของร้าน ไม่ใช่รหัสผ่าน Windows' 18
    $role=New-Object Windows.Forms.ComboBox
    $role.DropDownStyle='DropDownList';[void]$role.Items.Add('user');[void]$role.Items.Add('admin')
    $role.SelectedIndex=0;$role.Location=New-Object Drawing.Point(20,54);$f.Controls.Add($role)
    Label-On $f 'รหัสผ่าน (ไม่บันทึกลงไฟล์)' 94
    $password=New-Object Windows.Forms.TextBox
    $password.UseSystemPasswordChar=$true;$password.Location=New-Object Drawing.Point(20,123)
    $password.Width=420;$f.Controls.Add($password)
    $message=New-Object Windows.Forms.Label
    $message.Location=New-Object Drawing.Point(20,158);$message.Size=New-Object Drawing.Size(420,42);$f.Controls.Add($message)
    $login=New-Object Windows.Forms.Button
    $login.Text='เข้าสู่ระบบ';$login.Location=New-Object Drawing.Point(20,205);$login.Size=New-Object Drawing.Size(130,35);$f.Controls.Add($login)
    $login.Add_Click({
        $login.Enabled=$false
        try{
            $body=@{role=[string]$role.SelectedItem;password=$password.Text}|ConvertTo-Json
            $r=Get-JsonUtf8 -Uri ($script:Api+'?action=login') -Method Post -Body ([Text.Encoding]::UTF8.GetBytes($body))
            if(-not $r.ok -or -not $r.token){throw 'Login failed'}
            $script:Token=[string]$r.token;$password.Clear();$f.DialogResult='OK';$f.Close()
        }catch{$password.Clear();$message.Text='เข้าสู่ระบบไม่สำเร็จ ตรวจรหัสและอินเทอร์เน็ต';$login.Enabled=$true}
    })
    $f.AcceptButton=$login;$result=$f.ShowDialog();$f.Dispose()
    return ($result -eq [Windows.Forms.DialogResult]::OK)
}
function Get-WebConfig{
    $response=Api-Get 'action=bridge-config'
    if($null -eq $response.config -or -not $response.revision){throw 'โหลดการตั้งค่าจาก Admin ไม่สำเร็จ'}
    $response.config|Add-Member -NotePropertyName revision -NotePropertyValue ([string]$response.revision) -Force
    return $response.config
}
function Assert-Targets($Config){
    $installed=@([Drawing.Printing.PrinterSettings]::InstalledPrinters|ForEach-Object{[string]$_})
    $targets=New-Object System.Collections.ArrayList
    if($Config.counter.enabled){[void]$targets.Add(@{name=[string]$Config.counter.printer_name;station='เคาน์เตอร์'})}
    foreach($station in @($Config.stations)){[void]$targets.Add(@{name=[string]$station.printer_name;station=[string]$station.name})}
    if($targets.Count -eq 0){throw 'ยังไม่มีเครื่องพิมพ์เปิดใช้งานใน Admin'}
    foreach($target in $targets){
        if([string]::IsNullOrWhiteSpace($target.name)){throw ('กรุณาระบุชื่อเครื่องพิมพ์ใน Admin สำหรับ '+$target.station)}
        if($installed -notcontains $target.name){throw ('ไม่พบเครื่องพิมพ์ "'+$target.name+'" ของ '+$target.station+' ใน Windows โปรดแก้ชื่อใน Admin หรือติดตั้งเครื่องก่อน')}
    }
}
function Show-Targets($Config){
    $text=New-Object System.Collections.ArrayList
    if($Config.counter.enabled){[void]$text.Add('เคาน์เตอร์ -> '+$Config.counter.printer_name+' / '+$Config.counter.paper+' มม. (ใบเสร็จ + ใบจัดอาหารรวม)')}
    else{[void]$text.Add('เคาน์เตอร์: ปิดการพิมพ์')}
    foreach($station in @($Config.stations)){[void]$text.Add($station.name+' -> '+$station.printer_name+' / '+$station.paper+' มม.')}
    [void]$text.Add('')
    [void]$text.Add('เครื่องพิมพ์ที่ Windows พบ:')
    foreach($printer in [Drawing.Printing.PrinterSettings]::InstalledPrinters){[void]$text.Add('  '+[string]$printer)}
    return ($text -join [Environment]::NewLine)
}
function Get-Config{
    $f=New-Object Windows.Forms.Form
    $f.Text='Bake & Bite Print Bridge 0.2.1 - ใช้ค่าจาก Admin'
    $f.Size=New-Object Drawing.Size(700,570);$f.StartPosition='CenterScreen';$f.Font=New-Object Drawing.Font('Segoe UI',10)
    Label-On $f 'ตั้งชื่อเครื่องพิมพ์และสถานีจากหน้า Admin โปรแกรมนี้โหลดค่าตามเว็บ' 16
    $view=New-Object Windows.Forms.TextBox
    $view.Multiline=$true;$view.ReadOnly=$true;$view.ScrollBars='Vertical'
    $view.Location=New-Object Drawing.Point(20,48);$view.Size=New-Object Drawing.Size(640,280);$f.Controls.Add($view)
    $help=New-Object Windows.Forms.Label;$help.Location=New-Object Drawing.Point(20,340);$help.Size=New-Object Drawing.Size(640,70)
    $help.Text="โหลดค่าประมาณทุก 3 วินาที เพิ่มหรือเปลี่ยนเครื่องใน Admin แล้วกดบันทึก ไม่ต้องแก้โค้ด
ก่อนเริ่ม ปิดการเปิดหน้าพิมพ์ใบเสร็จหลังรับเงินสดในเว็บ แล้วบันทึกและรีเฟรช POS เพื่อไม่ให้ซ้ำ"
    $f.Controls.Add($help)
    $reload=New-Object Windows.Forms.Button
    $reload.Text='โหลดค่าล่าสุด';$reload.Location=New-Object Drawing.Point(20,430);$reload.Size=New-Object Drawing.Size(150,38);$f.Controls.Add($reload)
    $test=New-Object Windows.Forms.Button
    $test.Text='ทดสอบทุกเครื่อง';$test.Location=New-Object Drawing.Point(190,430);$test.Size=New-Object Drawing.Size(170,38);$f.Controls.Add($test)
    $ok=New-Object Windows.Forms.Button
    $ok.Text='เริ่มรับงาน';$ok.Location=New-Object Drawing.Point(380,430);$ok.Size=New-Object Drawing.Size(150,38);$f.Controls.Add($ok)
    $refreshView={
        $script:WebConfig=Get-WebConfig
        $view.Text=Show-Targets $script:WebConfig
    }
    $reload.Add_Click({try{& $refreshView}catch{[Windows.Forms.MessageBox]::Show($_.Exception.Message)|Out-Null}})
    $test.Add_Click({
        $test.Enabled=$false
        try{
            & $refreshView
            Assert-Targets $script:WebConfig
            $items=@()
            foreach($station in @($script:WebConfig.stations)){$items += [pscustomobject]@{name=('อาหารทดสอบ '+$station.name);quantity=1;line_total=50;department=[string]$station.name;station_id=[string]$station.id}}
            if($items.Count -eq 0){$items=@([pscustomobject]@{name='รายการทดสอบเคาน์เตอร์';quantity=1;line_total=50;department='เคาน์เตอร์';station_id=''})}
            $sample=[pscustomobject]@{order=[pscustomobject]@{id='TEST';order_no='TEST-001';display_order_no='TEST-001';created_at=[DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss');customer_name='ทดสอบ';total=($items.Count*50);payment_method='TEST';is_test=$true};points=[pscustomobject]@{earned=$items.Count;balance=12;pending=0;member_linked=$true};items=$items}
            if($script:WebConfig.counter.enabled){
                Send-Print ([string]$script:WebConfig.counter.printer_name) ([int]$script:WebConfig.counter.paper) (Get-Lines $sample 'receipt' $items)
                Send-Print ([string]$script:WebConfig.counter.printer_name) ([int]$script:WebConfig.counter.paper) (Get-Lines $sample 'packing' $items)
            }
            foreach($station in @($script:WebConfig.stations)){
                $stationItems=@($items|Where-Object{[string]$_.station_id -eq [string]$station.id})
                Send-Print ([string]$station.printer_name) ([int]$station.paper) (Get-Lines $sample 'station' $stationItems)
            }
            [Windows.Forms.MessageBox]::Show('ส่งงานทดสอบตามค่าจาก Admin เข้า Windows แล้ว กรุณาตรวจทุกเครื่อง ไม่มีการสร้างยอดขาย')|Out-Null
        }catch{[Windows.Forms.MessageBox]::Show($_.Exception.Message)|Out-Null}
        finally{$test.Enabled=$true}
    })
    $script:Chosen=$null
    $ok.Add_Click({
        try{
            & $refreshView
            Assert-Targets $script:WebConfig
            $script:Chosen=$script:WebConfig;$f.DialogResult='OK';$f.Close()
        }catch{[Windows.Forms.MessageBox]::Show($_.Exception.Message)|Out-Null}
    })
    try{& $refreshView}catch{$view.Text=$_.Exception.Message}
    $result=$f.ShowDialog();$f.Dispose()
    if($result -ne [Windows.Forms.DialogResult]::OK){return $null}
    return $script:Chosen
}
function Upgrade-State{
    if([int]$script:State.version -ge 2){return}
    $keys=@($script:State.jobs.Keys|Where-Object{[string]$_ -match '/kitchen$'})
    if($keys.Count -gt 0){
        if(-not (Test-Path $script:ConfigPath)){throw 'ต้องเก็บ config.json เดิมไว้เพื่อย้ายประวัติใบครัว โดยไม่พิมพ์ซ้ำ'}
        $old=Convert-ToMap (Get-Content $script:ConfigPath -Raw|ConvertFrom-Json)
        if(-not $old.station_id){throw 'ไม่พบ station_id ใน config.json เดิม หยุดเพื่อป้องกันพิมพ์ใบครัวซ้ำ'}
        foreach($key in $keys){
            $newKey=([string]$key -replace '/kitchen$',('/station-'+[string]$old.station_id))
            $script:State.jobs[$newKey]=$script:State.jobs[$key]
            [void]$script:State.jobs.Remove($key)
        }
    }
    $script:State.version=2
    Save-State
}
function Add-Line($List,[string]$Text,[bool]$Bold=$false){[void]$List.Add(@{text=$Text;bold=$Bold})}
function Get-Lines($Data,[string]$Kind,$Items){
    $lines=New-Object System.Collections.ArrayList;$o=$Data.order
    Add-Line $lines 'BAKE & BITE' $true
    $title=switch($Kind){'receipt'{'ใบเสร็จรับเงิน'}'packing'{'ใบจัดอาหารรวมทุกแผนก'}default{'ใบงานห้องครัว'}}
    Add-Line $lines $title $true
    if($o.is_test){Add-Line $lines 'ทดสอบ — ไม่ใช่ยอดขาย' $true}
    $number=if($o.display_order_no){$o.display_order_no}else{$o.order_no}
    Add-Line $lines ([string]$number) $true
    Add-Line $lines ([string]$o.created_at);Add-Line $lines ('ลูกค้า: '+[string]$o.customer_name)
    Add-Line $lines '-----------------------------'
    $qty=0
    foreach($item in $Items){
        $qty += [int]$item.quantity
        if($Kind -eq 'receipt'){Add-Line $lines (([string]$item.name)+' x '+$item.quantity+' = '+([decimal]$item.line_total).ToString('0.00')+' บาท')}
        else{Add-Line $lines ('[  ] '+([string]$item.name)+' x '+$item.quantity) $true;Add-Line $lines ('แผนก: '+[string]$item.department)}
    }
    Add-Line $lines '-----------------------------'
    if($Kind -eq 'receipt'){
        Add-Line $lines ('รวม '+([decimal]$o.total).ToString('0.00')+' บาท') $true
        Add-Line $lines ('ชำระ: '+[string]$o.payment_method)
        Add-Line $lines ('คะแนนที่รับครั้งนี้: '+[string]$Data.points.earned+' แต้ม')
        $balance=if($null -eq $Data.points.balance){'-'}else{[string]$Data.points.balance+' แต้ม'}
        Add-Line $lines ('ยอดคะแนนสะสม: '+$balance)
        if($Data.points.pending -gt 0){Add-Line $lines ('คะแนนรอรับผ่าน LINE: '+$Data.points.pending+' แต้ม')}
        if(-not $Data.points.member_linked){Add-Line $lines 'ออเดอร์นี้ยังไม่ผูกสมาชิก'}
        Add-Line $lines 'คะแนนสะสม ณ เวลาพิมพ์'
    }else{
        Add-Line $lines ('รวม '+$qty+' ชิ้น / '+@($Items).Count+' รายการ') $true
        Add-Line $lines '[  ] ตรวจจำนวนครบแล้ว';Add-Line $lines 'ผู้จัด ________ ผู้ตรวจ ________'
        Add-Line $lines 'ไม่ใช่ใบเสร็จรับเงิน'
    }
    if($o.note){Add-Line $lines ('หมายเหตุ: '+[string]$o.note)}
    return ,$lines
}
function Send-Print([string]$Printer,[int]$Paper,$Lines){
    $doc=New-Object Drawing.Printing.PrintDocument;$doc.PrinterSettings.PrinterName=$Printer
    if(-not $doc.PrinterSettings.IsValid){$doc.Dispose();throw ('เครื่องพิมพ์ไม่พร้อม: '+$Printer)}
    $doc.DocumentName='BakeBite - '+[string]$Lines[1].text
    $doc.PrintController=New-Object Drawing.Printing.StandardPrintController
    $width=[int][Math]::Round($Paper/25.4*100)
    $font=New-Object Drawing.Font('Tahoma',9);$bold=New-Object Drawing.Font('Tahoma',10,[Drawing.FontStyle]::Bold)
    $format=New-Object Drawing.StringFormat;$format.Trimming=[Drawing.StringTrimming]::None
    $doc.DefaultPageSettings.Margins=New-Object Drawing.Printing.Margins(6,6,6,6)
    $measure=$doc.PrinterSettings.CreateMeasurementGraphics()
    $measure.PageUnit=[Drawing.GraphicsUnit]::Display
    try{
        $height=18
        foreach($line in $Lines){
            $useFont=if($line.bold){$bold}else{$font}
            $size=$measure.MeasureString([string]$line.text,$useFont,($width-18),$format)
            $height += [int][Math]::Ceiling($size.Height)+4
        }
    }finally{$measure.Dispose()}
    $height=[Math]::Max(180,[Math]::Min(1100,$height))
    $doc.DefaultPageSettings.PaperSize=New-Object Drawing.Printing.PaperSize('BakeBite Roll',$width,$height)
    $position=@{index=0}
    $printBlock={
        param($sender,$e)
        $e.Graphics.PageUnit=[Drawing.GraphicsUnit]::Display
        $y=[single]$e.MarginBounds.Top;$printWidth=[single][Math]::Min($e.MarginBounds.Width,($width-18))
        while($position.index -lt $Lines.Count){
            $line=$Lines[$position.index];$useFont=if($line.bold){$bold}else{$font}
            $size=$e.Graphics.MeasureString([string]$line.text,$useFont,$printWidth,$format)
            $lineHeight=[single][Math]::Ceiling($size.Height)+4
            if($y+$lineHeight -gt $e.MarginBounds.Bottom -and $y -gt $e.MarginBounds.Top){$e.HasMorePages=$true;return}
            $rect=New-Object Drawing.RectangleF([single]$e.MarginBounds.Left,$y,$printWidth,$lineHeight)
            $e.Graphics.DrawString([string]$line.text,$useFont,[Drawing.Brushes]::Black,$rect,$format)
            $y += $lineHeight;$position.index++
        }
        $e.HasMorePages=$false
    }.GetNewClosure()
    $handler=[Drawing.Printing.PrintPageEventHandler]$printBlock
    $doc.add_PrintPage($handler)
    try{$doc.Print()}finally{$doc.Dispose();$font.Dispose();$bold.Dispose();$format.Dispose()}
}
function Save-State{Save-Json $script:StatePath $script:State}
function Send-Tracked($Data,[string]$Kind,[string]$Printer,[int]$Paper,$Items){
    $key=([string]$Data.order.id)+'/'+$Kind;$state=[string]$script:State.jobs[$key]
    if($state -eq 'submitted' -or $state -eq 'skipped'){return}
    if($state -eq 'sending' -or $state -eq 'attention'){
        $answer=[Windows.Forms.MessageBox]::Show(
            ("งาน "+$Data.order.order_no+" / "+$Kind+" เคยส่งแล้วแต่ยังยืนยันไม่ได้
ตรวจคิว Windows และกระดาษก่อน
Yes = พิมพ์ออกแล้ว ข้ามงานนี้
No = ส่งพิมพ์ซ้ำ (อาจได้ใบซ้ำ)
Cancel = หยุด Bridge"),
            'ตรวจงานพิมพ์ค้าง',[Windows.Forms.MessageBoxButtons]::YesNoCancel)
        if($answer -eq [Windows.Forms.DialogResult]::Yes){$script:State.jobs[$key]='submitted';Save-State;return}
        if($answer -ne [Windows.Forms.DialogResult]::No){throw 'หยุดเพื่อให้ตรวจงานพิมพ์ค้าง'}
    }
    if(@($Items).Count -eq 0){$script:State.jobs[$key]='skipped';Save-State;return}
    $script:State.jobs[$key]='sending';Save-State
    try{
        $lines=Get-Lines $Data $Kind $Items;Send-Print $Printer $Paper $lines
        $script:State.jobs[$key]='submitted';Save-State
        Write-Host ($Data.order.order_no+' / '+$Kind+' -> '+$Printer)
    }catch{$script:State.jobs[$key]='attention';Save-State;throw}
}
try{
    if(-not (Get-Login)){exit}
    $config=Get-Config;if($null -eq $config){exit}
    if(Test-Path $script:StatePath){
        $script:State=Convert-ToMap (Get-Content $script:StatePath -Raw|ConvertFrom-Json)
        if($null -eq $script:State.jobs -or -not $script:State.since){throw 'ประวัติงานพิมพ์ไม่สมบูรณ์ โปรดเก็บไฟล์เดิมไว้และแจ้งผู้ดูแล'}
        if([int]$script:State.version -lt 2){
            $backup=$script:StatePath+'.v1-backup'
            if(-not (Test-Path $backup)){Copy-Item -LiteralPath $script:StatePath -Destination $backup}
            Upgrade-State
        }
    }else{
        $script:State=@{version=2;since=[DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ');after='00000000-0000-0000-0000-000000000000';jobs=@{}}
        Save-State
    }
    Write-Host 'Bake & Bite Print Bridge 0.2.1 - Auto Admin Config'
    Write-Host (Show-Targets $config)
    Write-Host 'เปิด Bridge เพียงคอมเดียว / Ctrl+C เพื่อหยุด'
    $revision=[string]$config.revision;$lastError=''
    while($true){
        try{
            $config=Get-WebConfig
            Assert-Targets $config
            if([string]$config.revision -ne $revision){
                Write-Host 'โหลดค่าจาก Admin ใหม่แล้ว' -ForegroundColor Green
                Write-Host (Show-Targets $config)
                $revision=[string]$config.revision
            }
            if($lastError){Write-Host 'กลับมารับงานแล้ว' -ForegroundColor Green;$lastError=''}
            $since=[Uri]::EscapeDataString([string]$script:State.since)
            $after=[Uri]::EscapeDataString([string]$script:State.after)
            $feed=Api-Get ('action=bridge-orders&since='+$since+'&after='+$after)
            foreach($entry in $feed.orders){
                $data=Api-Get ('action=print-order&id='+[Uri]::EscapeDataString([string]$entry.id))
                if($data.order.payment_status -ne 'paid' -or $data.order.status -eq 'cancelled'){
                    $script:State.since=[string]$entry.paid_at;$script:State.after=[string]$entry.id;Save-State;continue
                }
                if($config.counter.enabled){
                    Send-Tracked $data 'receipt' ([string]$config.counter.printer_name) ([int]$config.counter.paper) @($data.items)
                    Send-Tracked $data 'packing' ([string]$config.counter.printer_name) ([int]$config.counter.paper) @($data.items)
                }
                foreach($station in @($config.stations)){
                    $stationItems=@($data.items|Where-Object{[string]$_.station_id -eq [string]$station.id})
                    Send-Tracked $data ('station-'+[string]$station.id) ([string]$station.printer_name) ([int]$station.paper) $stationItems
                }
                $script:State.since=[string]$entry.paid_at;$script:State.after=[string]$entry.id;Save-State
            }
        }catch{
            $message=[string]$_.Exception.Message
            if($message -like '*หยุดเพื่อให้ตรวจงานพิมพ์ค้าง*'){break}
            if($null -ne $_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 401){
                [Windows.Forms.MessageBox]::Show('สิทธิ์หมดอายุ กรุณาปิดและเปิด Bridge เพื่อเข้าสู่ระบบใหม่')|Out-Null;break
            }
            if($message -ne $lastError){
                Write-Host ('พักงาน / จะลองใหม่: '+$message) -ForegroundColor Yellow
                $lastError=$message
            }
        }
        Start-Sleep -Seconds 3
    }
}catch{[Windows.Forms.MessageBox]::Show($_.Exception.Message,'Bake & Bite Print Bridge')|Out-Null}
finally{$script:Token=$null;$mutex.ReleaseMutex();$mutex.Dispose()}
